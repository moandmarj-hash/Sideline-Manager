# Sideline Manager (dynamic fairness build)

This version changes the scheduling engine so it:
- drops the old fixed split logic
- uses a whole-game fairness target
- dynamically chooses each block's White / Red split
- keeps White replacing White and Red replacing Red
- rebalances after injuries and manual changes

It also includes:
- a polished landing page
- a custom red and white striped theme
- a new Sideline Manager icon / logo
- reset buttons on each injury / return section
- Sideline Manager naming throughout
- previous game history and balancing memory

This build intentionally avoids manifest / service worker files so it stays stable on protected Vercel deployments.
