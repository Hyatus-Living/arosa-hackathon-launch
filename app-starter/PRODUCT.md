# Arosa

Arosa is a US property research assistant for zoning and development possibilities, with tiered coverage: New York City deep (PLUTO parcels, curated envelope where encoded, footprint neighbours) and every other US city research-tier (live official sources for the auto-detected jurisdiction, generic concepts and pro forma, gaps named). A user signs in with an Arosa account, asks about a property in ordinary language, follows sourced research, and continues the conversation. Team Builder is a separate development experience.

The working product has account-scoped conversations and search, native Codex research, tool activity, steering, queued messages, stop, citations, property context and generated interactive views. The frontend must make these capabilities discoverable without becoming an operations dashboard.

This refactor replaces the accumulated frontend layout and styling while preserving the authenticated APIs and working research behavior. ChatGPT and Devin are interaction references: quiet navigation, a clear conversation hierarchy, responsive controls, progressive disclosure and stable streaming. Generated mockups guide composition; real components, accessibility and browser tests determine the implementation.

Success means a user can start, follow, interrupt and resume research naturally on desktop or mobile, find an earlier conversation, inspect evidence and understand when the agent is working. No decorative capability claims or unsupported controls belong in the interface.
