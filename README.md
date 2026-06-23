# Sideline Manager (failsafe build)

This build hardens the app against old localStorage data and non-array values, and renames the app to **Sideline Manager**.

It keeps:
- White squad / Red squad
- current block swap
- re-enter into future block
- unavailable / available again status controls
- weekly balancing from previous saved game
- game history
- all setup panels under Game Tools
- 1st Half / 2nd Half labels
- red Red squad tiles in Minutes summary

This version intentionally avoids the manifest/PWA files that were causing 401 errors on protected Vercel deployments.
