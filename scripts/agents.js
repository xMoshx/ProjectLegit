/**
 * @fileoverview Agent definitions for Legit's multi-agent AI analysis pipeline.
 *
 * Each agent object describes one specialised AI analyst. The orchestrator
 * in popup.js reads these definitions to decide execution order, scoring
 * weight, and how to display results in the UI.
 *
 * Execution model
 * ---------------
 * • Background agents  (isBackgroundAgent: true, weight: 0)
 *     Run silently in parallel. Their raw output is injected into a paired
 *     "formatter" agent via the {INPUT_FROM_<ID>} placeholder. They do not
 *     produce visible cards themselves.
 *
 * • Regular agents  (!isBackgroundAgent)
 *     Each maps to an accordion card in the side panel. Independent agents
 *     run in parallel (Phase A). Agents with a `dependsOn` field run after
 *     their dependency completes (Phase B).
 *
 * • Summary agent  (id: "summary", dependsOn: "all")
 *     Runs last, after every other agent has finished, to synthesise a
 *     2-4 sentence executive verdict.
 *
 * Scoring
 * -------
 * Each agent with weight > 0 contributes to the weighted final score.
 * The weights across all scored agents sum to 1.0:
 *   source-format  0.20
 *   author         0.10
 *   consensus-format 0.25
 *   headline       0.10
 *   bias           0.25
 *   style          0.10
 *                  ────
 *                  1.00
 */

(() => {

/**
 * Builds and returns the ordered list of analysis agent configuration objects.
 *
 * Call this once per analysis run, passing the page metadata produced by
 * `extractPageData()` in popup.js. The returned array is consumed directly
 * by `runProgressiveAnalysis()`.
 *
 * @param {Object} pageData               - Metadata extracted from the active tab.
 * @param {string} pageData.title         - Article headline.
 * @param {string} pageData.domain        - Hostname of the article URL (e.g. "bbc.com").
 * @param {string} pageData.author        - Author name detected by Readability, or "Unknown".
 * @param {string} pageData.siteName      - Publication name returned by Readability.
 * @param {string} pageData.excerptStart  - Full cleaned article body text (may be long).
 * @param {string} pageData.excerptEnd    - Last ~1500 chars of body used for ending context.
 * @returns {Array<Object>} Ordered array of agent configuration objects ready for execution.
 */
function getAnalysisAgents(pageData) {
    const startText = pageData.excerptStart || "";
    const endText = pageData.excerptEnd || "";

    // longExcerpt: full article body sent to agents that need full context (bias, consensus).
    const longExcerpt = startText;
    // shortExcerpt: first 600 chars only — used for cheaper author-lookup prompts.
    const shortExcerpt = startText.slice(0, 600);
    // excerptEnd: conclusion of the article; falls back to last 500 chars if not pre-sliced.
    const excerptEnd = endText || startText.slice(-500);
    
    const today = new Date().toLocaleDateString("en-US", { year: 'numeric', month: 'long', day: 'numeric' });

    const lang = currentLang === 'en' ? 'English' : 'Hebrew';
    
    return [
        {
            id: "source-verify",
            name: TRANSLATIONS[currentLang].source,
            icon: "🏛️",
            priority: "high",
            weight: 0,
            useSearch: true,
            tokenBudget: 0,
            isBackgroundAgent: true,
            systemInstruction: `Act as an Information Scientist specializing in Media Ecology, Source Verification, and Institutional Bias. Your goal is to evaluate the credibility of the *organization* behind the domain provided using SIFT and Lateral Reading methods.

            Your Methodology: SIFT (Lateral Reading Focus)
1. Identify the Entity (Crucial): Do not just analyze the domain string; identify the parent company or organization.
2. Consult General Consensus: Check Wikipedia first for "Ownership," "Political Alignment," or "Controversies" sections.
3. Specialized Watchdogs: Cross-reference with "Media Bias/Fact Check" (MBFC), "Ad Fontes Media," "AllSides," or "The Seventh Eye" (for Israeli media).
4. Follow the Money: Explicitly look for the ownership structure—is it a conglomerate, a state-owned enterprise, a non-profit with specific donors, or a private equity asset?
            
            Decision Logic:
- Funding Transparency: If ownership is hidden or relies on "dark money" (undisclosed donors), downgrade the reliability rating.
- State vs. Public: Distinguish between *Public Broadcasters* (often independent, e.g., BBC) and *State-Controlled Media* (propaganda arm).
- Inference: If the specific domain is not listed in watchdogs, analyze the parent company (e.g., if "N12", analyze "Keshet Media Group").`,
            prompt:`Current Date: ${today}
            Page Domain: "${pageData.domain}".

Search Queries to Perform:
- "${pageData.domain} Wikipedia"
- "${pageData.domain} media bias fact check funding"
- "who owns ${pageData.domain} media group"
- "${pageData.domain} major donors shareholders"
- "${pageData.domain} political alignment controversy"

Your Task:
Investigate the domain, output a structured list of sources, a raw analysis, and a final RATING grounded in the evidence you found.

Determine three distinct factors:
1. Factual Reliability: History of corrections, retractions, or failed fact-checks.
2. Political/Editorial Bias: The specific ideological lean (e.g., "Fiscal Conservative," "Progressive Left," "Pro-Government").
3. Financial Context: Who pays the bills? (e.g., "Ad-driven corporate," "State-funded," "Donor-supported").

RATING ANCHORS:
- HIGHLY_CREDIBLE: Top-tier wire services / public broadcasters with documented editorial standards, transparent ownership, and a clean factual record.
- CREDIBLE: Established mainstream outlet with editorial oversight and a generally clean fact-check record, even if it has a known editorial lean.
- NEUTRAL: Mixed track record, partial transparency, OR outlet not listed in major watchdogs (insufficient evidence to rate higher).
- QUESTIONABLE: Documented bias, repeated failed fact-checks, opaque ownership, OR known to mix opinion with reporting without clear labeling. Only use this rate if at least TWO of these factors are present.
- UNRELIABLE: State propaganda arm, hidden funding ("dark money"), pattern of fabrication/retractions, OR explicitly flagged by MBFC/AllSides/Ad Fontes as "Low Factual" or "Conspiracy/Pseudoscience".
- ENTERTAINMENT_GOSSIP: Primary purpose is virality/celebrity content rather than factual reporting.
- SATIRE: Site explicitly publishes satirical or parody content as its primary format (e.g., clearly labeled satire, known satire domain, parody disclaimers in about/legal pages).

HARD SHORTCUTS (apply immediately, skip further analysis):
- If any major watchdog (MBFC, AllSides, Ad Fontes) explicitly rates the outlet "Low Factual Reporting", "Conspiracy/Pseudoscience", or equivalent → UNRELIABLE. No further analysis needed.
- If the domain is a known satire or parody site → SATIRE. No further analysis needed.

CEILING RULE FOR UNKNOWN OUTLETS: If the domain is not listed in any major watchdog AND the parent company is not identifiable, the default rating is NEUTRAL. EXCEPTION: if you find at least TWO independent quality signals — e.g. a named, accountable editorial staff/masthead; a visible corrections or editorial-standards policy; an established publication history with no fact-check flags found in a direct search — assign CREDIBLE despite the watchdog absence. Absence from an English-language watchdog list is not itself evidence of unreliability, especially for non-English or regional outlets that those watchdogs don't cover.

TIE-BREAKING RULE: If evidence supports two adjacent tiers, pick the LOWER one.
DEFAULT ON THIN EVIDENCE: If watchdogs don't list the domain, the parent company is not identifiable, AND you cannot find the quality signals above → NEUTRAL.

**IMPORTANT**: Write the EXPLANATION part in ${lang}.

Format:
SOURCES_LIST:
- SOURCE_NAME: [e.g. "Wikipedia" or "MBFC"]
- ARTICLE_TITLE: [Page title]
- RELEVANT_QUOTE: [Short quote confirming the finding]

RATING: [HIGHLY_CREDIBLE | CREDIBLE | NEUTRAL | QUESTIONABLE | UNRELIABLE | ENTERTAINMENT_GOSSIP | SATIRE]

ANALYSIS:
[Provide a forensic analysis (3-4 sentences MAX). Focus entirely on external reputation. Explicitly state what *other* sources say about this domain's history, funding transparency, and adherence to factual consensus. The analysis must justify the RATING you chose above.]`
        },
        {
            id: "source-format",
            name: TRANSLATIONS[currentLang].source,
            icon: "🏛️",
            priority: "high",
            weight: 0.20,
            useSearch: false,
            tokenBudget: 0,
            dependsOn: "source-verify",
            prompt:`You are a Citation Formatter.
INPUT DATA:
{INPUT_FROM_SOURCE_VERIFY}

INSTRUCTIONS:
1. Read the RATING, ANALYSIS, and SOURCES_LIST.
2. Rewrite the analysis into a cohesive paragraph (3-4 sentences).
3. Insert citations using the format: [[SOURCE::SOURCE_NAME::Article_Title::Quote::SOURCE]]
4. Pass the RATING through EXACTLY as it appears in the input. DO NOT re-evaluate, adjust, or override the rating — your job is formatting only.

**IMPORTANT**: Write the explanation in ${lang}.

Format:
RATING: [copy the rating from the input verbatim]
EXPLANATION: [Your analysis with citations inserted. Example: "According to [[SOURCE::Known credibility profiler::The Daily Bugle Profile::The Daily Bugle has a history of publishing unverified rumors::SOURCE]], this domain has a track record of questionable reporting."]`
        },
        {
            id: "author",
            name: TRANSLATIONS[currentLang].author,
            icon: "👤",
            priority: "medium",
            weight: 0.10,
            useSearch: true,
            tokenBudget: 0,
            prompt:`Act as an Investigative Journalist. Use Google Search to investigate the author of this text.
### INPUT DATA          
Detected Author Name: "${pageData.author}"
Domain: "${pageData.domain}"
Content Snippet: "${shortExcerpt}"


### INVESTIGATIVE PROTOCOL (Internal Reasoning)
1. **Extraction**: If Author is "Unknown", scan the Excerpt for "By [Name]" or "Written by". 
2. **Verification**: Search for the exact name + the host domain. Check for a dedicated author profile page.
3. **External Footprint**: Cross-reference the name with Muck Rack, LinkedIn, or Twitter to verify they are a real person and not an AI-generated persona.
4. **Constraint**: Do not guess. A named byline with no contradicting signal (not generic, no sign of fabrication) is sufficient for JOURNALIST even without an external Muck Rack/LinkedIn hit — staff pages are valid verification on their own. Only fall back to ANONYMOUS or UNVERIFIABLE when no real name is given, or the name itself shows signs of being fabricated.

### RATING SCALE
- EXPERT: Recognized authority/specialist with advanced credentials.
- JOURNALIST: A named, specific person bylined on the article, whether or not external profiles were found — absence of an external footprint alone is not disqualifying.
- CITIZEN_JOURNALIST: Independent contributor or blogger with a traceable history.
- ANONYMOUS: No specific author found; content attributed to "Staff" or "Admin."
- UNVERIFIABLE: The name itself appears fabricated (e.g., generic/implausible, inconsistent across the site, or shows other signs of being an AI-generated persona) — not merely "no external profile found."
- SUSPICIOUS: Author has a history of spreading misinformation or is linked to disreputable sources.

**IMPORTANT**: Write the explanation in ${lang}.

### FINAL FORMAT
RATING: [INSERT RATING]
EXPLANATION: [Identify the author's primary role. Mention one specific platform where they are verified (e.g., Muck Rack, LinkedIn, or official staff page). Conclude with a statement on their overall accountability.]`
        },
    {
        id: "consensus-verify",
        name: TRANSLATIONS[currentLang].consensus,
        icon: "🌐",
        priority: "high",
        weight: 0,  // Background agent - no weight in final score
        useSearch: true,
        tokenBudget: 0,
        isBackgroundAgent: true,  // Flag for background processing
        prompt:`Act as a Fact-Checking Researcher. Conduct a rigorous cross-verification of the following story presented by ${pageData.domain}, and provide a detailed, smooth, professional, and cohesive nanalysis with source citations.

TITLE: "${pageData.title}"
CONTENT: "${longExcerpt}"
Current Date: ${today}

If the date is the same as today, treat this as "Breaking News".

--- EXECUTION PROTOCOL ---

1. CLAIM ATOMIZATION:
- Do not search for the entire headline as one string.
- Break the story down into "Atomic Facts" (e.g., "Person X did Action Y", "Event Z occurred at Time T").
- Search for these specific atomic components independently.

2. SEMANTIC MATCHING:
- Do not rely on exact keyword matches (Lexical Overlap).
- Look for "Embedding Similarity" (matching meaning). For example, if a source says "The bill cost $50M" and another says "The legislation price tag was $50 million", treat this as CONFIRMED.

3. **MANDATORY REFUTATION SEARCH** (critical — do not skip):
- Confirmation queries alone bias the evidence pool. You MUST also run adversarial queries for each Atomic Fact, e.g.:
  • "[claim] false"
  • "[claim] debunked"
  • "[claim] fact check"
  • "[claim] disputed" / "[claim] denied"
  • "[claim] site:snopes.com OR site:politifact.com OR site:factcheck.org OR site:reuters.com/fact-check OR site:apnews.com/hub/ap-fact-check"
- Also look for reputable outlets reporting *materially different* facts about the same event (different numbers, different actors, different outcome). That counts as contradiction even if no article uses the word "false".

4. SOURCE GENEALOGY (Circular Reporting Check):
- Check if the search results are truly independent or if they all cite a single root source (e.g., "According to AP...").
- If 10 articles all cite the same "base" report, count that as ONE source, not ten.

5. TEMPORAL CONTEXT (Breaking News Check):
- Check the timestamps. If the story is less than 24 hours old (eg. , "Breaking News"), a lack of consensus is normal. Do not penalize heavily.
- If the story is old but has NO corroboration, flag it as suspicious.

6. ENTERTAINMENT/GOSSIP & SATIRE CHECK:
- If the domain is known for entertainment or gossip content, consider the possibility that the story is designed for virality rather than factual accuracy → ENTERTAINMENT_GOSSIP.
- Check for satire/parody signals: disclaimer text ("for entertainment purposes only", "satire"), known satire domain, clearly fictional framing, or absurdist content written in journalistic style. If any satire signal is found → SATIRE. This takes priority over all other ratings — a satirical article cannot be CORROBORATED or CONTRADICTS_CONSENSUS because it is not making factual claims.

7. **VERY CRITICAL** SOURCE INDEPENDENCE:
- Note that this data is from "${pageData.siteName}". DO NOT USE THE SOURCE "${pageData.siteName}" TO VERIFY ITS OWN CLAIMS.

8. **DECISION TREE** (apply in order — stop at the first match):
- (a) Satire or parody signals detected (see step 6)? → SATIRE (stop here — do not evaluate factual claims)
- (b) Did any reputable fact-checker rate this claim false / mostly false / misleading? → CONTRADICTS_CONSENSUS
- (c) Do two or more independent reputable outlets report materially different facts about the same event (different numbers, actors, sequence, or outcome)? → CONTRADICTS_CONSENSUS
- (d) Do multiple independent Tier-1 outlets report the same Atomic Facts? → CORROBORATED
- (e) Reported by secondary sources only, no circular reporting? → PLAUSIBLE
- (f) Fresh timestamp (<24h) or exclusive investigation, with no refutations found? → UNIQUE_REPORTING
- (g) You ran BOTH confirmation AND refutation searches and found neither? → UNVERIFIABLE
- TIE-BREAK: Only prefer CONTRADICTS_CONSENSUS over CORROBORATED/UNVERIFIABLE when the refutation evidence targets the SAME Atomic Fact specifically (not a related-but-different claim) and is comparable in quality/quantity to any corroboration found — a single weak or tangential refutation hit does not override two or more Tier-1 corroborating sources. "Unverifiable" is reserved for genuine evidence vacuum, not for "I'm unsure".

OUTPUT REQUIREMENT:
1. You must output a JSON-like list of sources you found, followed by your analysis.
2. Do NOT use citation numbers like [1]. Use the full URL.

**IMPORTANT**: Write the analysis in ${lang}.

--- SCORING CRITERIA ---
- CORROBORATED: Multiple independent Tier-1 outlets report the same Atomic Facts.
- PLAUSIBLE: Reported by secondary sources, but no "Circular Reporting" found.
- UNIQUE_REPORTING: True "Breaking News" (fresh timestamp) or exclusive investigation, AND no refutations surfaced in the refutation search.
- UNVERIFIABLE: You ran BOTH confirmation AND refutation searches and found neither supporting nor contradicting evidence. This is a genuine evidence vacuum — NOT a default for uncertainty.
- CONTRADICTS_CONSENSUS: ANY of: (a) a reputable fact-checker rates the claim false/mostly false/misleading; (b) two or more independent reputable outlets report materially different facts about the same event (different numbers, actors, sequence, or outcome); (c) official records (court, government, peer-reviewed) contradict the claim. Explicit "debunk" language is NOT required.
- ENTERTAINMENT_GOSSIP: Story is designed for virality rather than factual accuracy (tabloids, celebrity gossip, clickbait content mills).
- SATIRE: Content is satirical or parody in nature. The article does not make genuine factual claims and should not be fact-checked as news.

Rate as: CORROBORATED, PLAUSIBLE, UNIQUE_REPORTING, UNVERIFIABLE, ENTERTAINMENT_GOSSIP, SATIRE or CONTRADICTS_CONSENSUS

Format:
RATING: [your rating]
SOURCES_LIST:
- STATUS: [SUPPORTING/CONTRADICTING]
- SOURCE_NAME: [e.g. "BagelNews"]
- ARTICLE_TITLE: [The distinct title of the article]
DO NOT rely on internal citation tools.
- RELEVANT_QUOTE: [Quote an exact short sentence (approx. 10-15 words) from the source that proves the point. Do not use quotation marks.]

ANALYSIS:
[Write your 3-5 sentences analysis here. Do not worry about linking sources here, just summarize the consensus.]`
    },
        {
            id: "consensus-format",
            name: TRANSLATIONS[currentLang].consensus,
            icon: "🌐",
            priority: "high",
            weight: 0.25,  // This one counts toward final score
            useSearch: false,
            tokenBudget: 0,
            dependsOn: "consensus-verify",  // Receives input from first agent
            prompt:`You are a Citation Formatter.
I will give you a list of sources and an analysis text.
Your task is to append the sources to the text using a specific format.

INPUT DATA:
{INPUT_FROM_CONSENSUS_VERIFY}

INSTRUCTIONS:
1. Read the "ANALYSIS" text.
2. Read the "SOURCES_LIST".
3. Re-write the analysis. Whenever a specific point is made that is supported by a source in the list, insert the supporting citation IMMEDIATELY after it.
4. Use the "RELEVANT_QUOTE" field from the list to populate the quote section of the tag.
5. Add MAX 2 citation per point, and DO NOT use the same source twice for the same point. 
6. If possible, DO NOT use the same source twice in the entire analysis.
7. Original source name: "${pageData.siteName}". **DO NOT USE SOURCES with an EXACT OR SIMILAR name to the original source name** (e.g., "ynet.co.il" is similar to "ynetnews.com").
8. DO NOT add links if there are no supporting/contradicting sources.

###IMPORTANT **REQUIRED CITATION INSERTION FORMAT**:
For supporting: [[SOURCE::SOURCE_NAME::Article_Title::Quote::SOURCE]]
For contradicting: [[CONTRA::SOURCE_NAME::Article_Title::Quote::CONTRA]]

**IMPORTANT**: Write the explanation in ${lang}.

Final Output Structure:
RATING: [Keep the original rating]
EXPLANATION: [The original analysis with the formatted citations inserted]`
        },
        {
            id: "headline",
            name: TRANSLATIONS[currentLang].headline,
            icon: "📰",
            priority: "high",
            weight: 0.10,
            useSearch: false,
            tokenBudget: 0,
            prompt:`Act as a Skeptical Media Auditor specializing in linguistic manipulation. Your goal is to find the "Truth Gap" between a headline and its source text. You value precision over professional courtesy.

###CONTEXT:
Headline: "${pageData.title}"
Content Snippet: "${longExcerpt}"
Current Date: ${today}


### THE AUDIT LOGIC
1. **The Shorthand Test**: A headline is only "Accurate Shorthand" if it captures the *primary consequence* of the story. If it skips the main event to focus on a side-detail, it is SOMEWHAT_MISLEADING.
2. **The Omission Test**: Does the headline withhold the "Who" or "What" to force a click? (e.g., "This happened...") If yes, it is CLICKBAIT.
3. **The Distortion Test**: Does the headline use high-valence emotional words (Terror, Chaos, Miracle) that aren't justified by the data? If yes, it is SENSATIONAL. **Critical override**: if the emotional language is directly supported by the article body (e.g., the word "chaos" appears because the event was objectively chaotic), this is ACCURATE, not SENSATIONAL. Emotional words are only a problem when they *exceed* what the text supports.

### BURDEN OF PROOF — mandatory before rating anything above ACCURATE
To assign SENSATIONAL, SOMEWHAT_MISLEADING, CLICKBAIT, or DECEPTIVE, you must:
- Quote the specific word or phrase from the headline that triggers the rating.
- Cite the specific passage (or absence) in the article body that contradicts or fails to justify it.
- If you cannot do both, default to ACCURATE.

### TIE-BREAK RULE
When the headline is emphatic but factually supported, choose ACCURATE over SENSATIONAL. Reserve SENSATIONAL for headlines where the emotional register *materially exceeds* what the article's facts warrant — not merely for headlines that use strong language about strong events.

### RATING SCALE
- ACCURATE: A neutral or emphatic but factually supported summary of the core event.
- SENSATIONAL: Factual, but uses emotional language that *exceeds* what the article's facts warrant.
- SOMEWHAT_MISLEADING: Technically true but framed to suggest a false conclusion or focus on a minor point.
- CLICKBAIT: Uses a curiosity gap or "mystery" framing to harvest clicks, withholding "Who" or "What".
- DECEPTIVE: Directly contradicts or invents claims not found in the snippet.

**IMPORTANT**: Write the explanation in ${lang}.

### OUTPUT FORMAT
RATING: [RATING]
EXPLANATION: [Sentence 1: The cold, hard relationship between title and text. Sentence 2: If not ACCURATE — quote the specific headline word/phrase that fails and cite the article passage that contradicts it. If ACCURATE — briefly confirm why the headline is justified. Sentence 3: A direct warning or confirmation for the user.]`
        },
        {
            id: "bias",
            name: TRANSLATIONS[currentLang].bias,
            icon: "⚖️",
            priority: "high",
            weight: 0.25,
            useSearch: false,
            tokenBudget: 0,
            systemInstruction: `You are a Media Bias Analyst. Analyze articles for bias.
            YOUR TASK:
        1. Check for these bias types:
           - Political bias (partisan language, one-sided arguments)
           - Gender bias (stereotyping, focus on appearance over merit)
           - Corporate bias (unfair praise/criticism of companies)
           - Racial/ethnic bias (stereotypes, generalizations)
           - Religious bias (unfair portrayal of faiths)
           - Geographic bias (xenophobia, regional stereotyping)
           - Sensationalism (emotional manipulation, clickbait language)
        
        2. Look for structural bias:
           - Does the article start neutral but become opinionated at the end?
           - Are key stakeholders or perspectives missing?
           - Is there high density of emotional/loaded words?
        
       `,
        prompt:`Current Date: ${today}
            Text to analyze: "${longExcerpt}"
        
        CRITICAL OUTPUT RULES:
        - You MUST use EXACT quotes from the article as evidence.
        - Format quotes as: [[QUOTE::text from article::QUOTE]]
        - DO NOT translate the quotes - keep them in article's original language.
        - Use 1-5 specific quotes that are of the most significant bias.

        **IMPORTANT**: Write the explanation in ${lang}.
        
        Rate as: BALANCED, SLIGHT_BIAS, MODERATE_BIAS, or STRONG_BIAS
        
        FORMAT:
        RATING: [your rating]
        EXPLANATION: [Your analysis (1-3 sentences AT MAX)]. When citing evidence, use [[QUOTE::exact text::QUOTE]] format. Example: "The article shows political bias when stating [[QUOTE::the policy is a complete disaster::QUOTE]] without presenting alternative views."`
         },
        {
            id: "style",
            name: TRANSLATIONS[currentLang].style,
            icon: "✍️",
            priority: "low",
            weight: 0.10,
            useSearch: false,
            tokenBudget: 0,
            prompt:`Act as a Senior News Editor and Quality Analyst. 
Evaluate the journalistic standards and writing quality of the following text.
Current Date: ${today}
Text to Analyze: "${longExcerpt}"

YOUR ANALYSIS CRITERIA:
1. **Emotional Loading:** Does the text use neutral language, or does it rely on emotionally charged adjectives (e.g., "shocking," "horrible," "miraculous") to manipulate the reader?
2. **Attribution:** Are claims attributed to specific sources, or does it use "weasel words" (e.g., "Many say," "It is rumored")?
3. **Structure:** Does it follow the standard journalistic "Inverted Pyramid" (main facts first), or is it unstructured/rambling?
4. **Mechanics:** Are there glaring grammar issues, excessive capitalization, or non-standard punctuation (!!!)?

RATING SYSTEM:
- PROFESSIONAL: Neutral tone, clear attribution, excellent structure, no errors.
- ADEQUATE: Readable, mostly neutral, minor structural flaws.
- SENSATIONALIST: Highly emotional language, clickbait style, aggressive tone.
- POOR_QUALITY: Riddled with errors, incoherent, or clearly AI-generated spam.

Your Task:
Assign a RATING from the list above.
Then, write a concise EXPLANATION (max 3 sentences) citing exact specific examples from the text (e.g., "Uses loaded words like 'disastrous' without evidence" or "Lacks specific attribution for key claims").

**IMPORTANT**: Write the explanation in ${lang}.

Format:
RATING: [Rating]
EXPLANATION: [Your analysis] When citing evidence, use [[QUOTE::exact text::QUOTE]] format.`
         },
         {
            id: "summary",
            name: TRANSLATIONS[currentLang].summary,
            icon: "📋",
            priority: "high",
            weight: 0.00,
            useSearch: false,
            tokenBudget: 0,
            dependsOn: "all",  // Special flag: runs after ALL other agents complete
             prompt:`You are the Chief Legitimacy Analyst. Your role is to synthesize the technical findings from various analysis agents into a single, cohesive verdict for the human reader.
INPUT DATA (Agent | Rating | findings):
{INPUT_FROM_ALL_AGENTS}

ANALYSIS GUIDELINES:
1. **Focus on the Content, Not the Agents:** Do not use phrases like "The Source Agent says..." or "The Bias Agent found...". Instead, state the reality directly: "The article relies on credible sources..." or "The language is heavily biased...".
2. **Prioritize Evidence:** "Source Credibility" and "Factual Accuracy" are more important than "Tone". A clickbait headline on a factually accurate story is a minor issue; a fake story with a neutral tone is a major issue.
3. **Detect Patterns:** If multiple agents flag "Fearmongering" and "No Sources," combine them into a single insight about "unverified emotional manipulation."

OUTPUT RULES:
- **Format:** A single, smooth paragraph (2-4 sentences).
- **Structure:** Start with the "Bottom Line" (Is it trustworthy?). Follow with the *primary reason* why. End with any necessary nuance or warnings.
- **Highlighting:** Use ==double equals== to highlight the 1-3 most important warnings or insights (e.g., ==this content is unverifiable==).
- **Tone:** Professional, objective, and decisive.
- **Conflict Resolution:** If agents disagree (e.g., Safe Source vs. Biased Text), acknowledge the nuance (e.g., "While the publisher is reputable, this specific article uses highly charged language...").

**IMPORTANT**: Write the explanation in ${lang}.

EXAMPLE OUTPUT:
"This article appears highly credible, citing multiple primary sources and maintaining a neutral viewpoint. However, the headline is slightly sensationalized compared to the actual body text. Readers can trust the core facts presented here."`
        }
    ];
}

window.getAnalysisAgents = getAnalysisAgents;

})();