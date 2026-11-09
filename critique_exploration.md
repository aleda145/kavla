This is a promising first implementation, but it currently feels more like a menu of SQL tasks than a genuine crossroads.

The interaction is there: the agent investigates, proposes directions, and waits for the analyst. But I see a few problems.

### 1. The agent is doing too much talking

The long introductory paragraph, three descriptions, and SQL previews make this feel like reading an AI report.

I'd prefer something closer to:

CROSSROADS

Miljöpartiet abstained in about 21% of recorded votes. Is that unusual?

Where should we investigate?

Compare parties

Is this typical across the Riksdag?

Explore individual MPs

Who abstains, and when?

Investigate specific votes

Which issues produce these patterns?

### 2. These aren't really canvas branches yet

The options are stacked vertically, like a form.

I'd like to see actual proposed nodes spatially branching from the current analysis. Selecting one would confirm the branch and start exploring it. The others could disappear or remain as subdued possibilities.

That makes the investigation feel like something the analyst is building, rather than a conversation they're responding to.

### 3. The agent is missing an important issue in its own analysis

Your screenshot says 2,494 abstentions out of 11,808 votes is 24%. That's actually about 21%.

Also, the four outcome counts add up to 11,408, leaving 400 votes unaccounted for.

And the agent calls the abstention rate "striking" without first comparing it with other parties.

This is exactly the kind of uncertainty that should influence the crossroads. The agent needs to distinguish observations from interpretations, and verify its calculations before drawing attention to something.

### 4. Most importantly: why these three paths?

The agent should communicate why there's a decision to make now.

A crossroads should emerge because the investigation reaches a meaningful fork, not simply because the agent has generated three possible queries.

I'd make one major change first:

Turn the crossroads from a list of proposed SQL operations into a visual fork between meaningful analytical questions.

The SQL is implementation detail. The analyst should be choosing what they want to understand next, not which query to run.

That would move Kavla much closer to the bicycle-for-the-mind idea.
