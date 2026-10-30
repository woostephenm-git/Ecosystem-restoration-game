# Idea: multiplayer specialist mode (university learning activity)

Status: **idea for a later stage. Not scheduled, not designed.** Recorded 2026-10-29.

## The idea

A multiplayer version for a university class. Each player is a specialist in one field (hydrology, chemistry, flora, fauna, and so on). No one can restore the site alone. Players have to:

- **Share resources:** for example a common budget that they negotiate over, or separate budgets that they can pool.
- **Share information, like a cooperative escape room:** what one specialist finds clarifies things for the others and opens up new options for them, because the variables are linked across layers.

## Why it fits the existing design

- **Layers become roles.** Each variable already belongs to exactly one layer, so each player can own one layer.
- **Cross-layer links force collaboration.** A link's `discovered_by` list can name variables from different layers. Example: `carp_uproot_plants` connects fauna to flora, so neither specialist can discover it alone.
- **Wrong-layer causes (design pillar 1) become a social puzzle.** The flora player sees plants dying, but the cause sits in the fauna player's data.
- **"Monitoring costs something" (design pillar 2) becomes a negotiation.** Whose sampling gets funded first?

## Open questions for when this is picked up

- **Visibility:** does each player see only their own layer's values, or can everyone see everything but only their own specialist can sample it?
- **Communication:** in-game messages, or talking around a table, with the game giving each player different information to bring?
- **Budget:** one shared pot, separate budgets, or both (personal plus a joint fund)?
- **Who can act:** do interventions belong to specific roles? For example, only the fauna specialist can order carp removal.
- **Group size:** how does the game scale for 2, 3 or 5 players? Which layers merge when there are fewer people?
- **Assessment:** what does the instructor see afterwards? A replay of who discovered what and when, and how information flowed between players.
- **Technical:** the game currently has one knowledge state. This mode needs one per player, plus a networking or shared-state layer.
