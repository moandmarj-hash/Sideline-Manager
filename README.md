# Rugby Interchange Scheduler (stable fix)

This build fixes the blank page caused by the missing `TopMetaBar` component and removes the private-deployment PWA hooks that were causing `manifest.webmanifest` 401 errors on protected Vercel deployments.

Included features:
- White squad / Red squad naming
- compact current block view
- current block swap
- re-enter into future block
- unavailable / available again status controls
- weekly balancing from previous saved game
- game history
- all setup panels under Game Tools
- rotation plan titles use 1st Half / 2nd Half and keep Match minutes in the subtitle
- Red squad tiles stay red in Minutes summary

## Run locally
```bash
npm install
npm run dev
```
