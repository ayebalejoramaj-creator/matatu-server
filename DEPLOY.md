# Deploying this — step by step (no coding needed)

## 1. Create a GitHub account
Go to https://github.com and sign up (free).

## 2. Create a new repository
- Click the "+" in the top right → "New repository"
- Name it `matatu-server`
- Leave it Public or Private, either is fine
- Click "Create repository"

## 3. Upload these files
On the new repo's page, click "uploading an existing file" (or "Add file" →
"Upload files"), then drag in every file from this folder EXCEPT the
`node_modules` folder if one exists (there shouldn't be one). Commit the
upload.

## 4. Create a Render account
Go to https://render.com and sign up (free tier is enough to start).

## 5. Create a new Web Service
- Click "New" → "Web Service"
- Connect your GitHub account, select the `matatu-server` repo
- Settings:
  - **Build command:** `npm install`
  - **Start command:** `npm start`
  - **Instance type:** Free
- Click "Create Web Service"

Render will build and deploy it. In a minute or two you'll get a live URL
like `https://matatu-server-xxxx.onrender.com` — that's your server,
online, in your region-reachable-by-anyone sense (Render's free tier runs
on shared US/EU infrastructure by default; more on regions below).

## 6. Test it
Open the URL Render gives you. You'll see a bare test page (not the styled
game yet) — click "Create public room", then open the same URL in a second
tab and "Join by code" using the code shown. Draw/play a card in one tab
and confirm the other tab's state updates. If that works, the whole
plumbing — rooms, lobby, real-time sync, turn enforcement — is solid.

## About "accessible in my region"
Render lets you pick the server region (e.g. Frankfurt, Singapore, Ohio,
Oregon) in the Web Service settings — pick whichever is geographically
closest to your players for the best latency. The site itself will still
be reachable worldwide; region just affects speed, not who can access it.

## Note on the free tier
Render's free web services sleep after 15 minutes of no traffic, and take
~30-50 seconds to wake back up on the next visit. Fine for testing and an
early launch; if you outgrow it, upgrading to a paid instance (~$7/mo)
removes the sleep delay.

## Next step
Once this is deployed and confirmed working, the next round is replacing
this bare test page with your actual Matatu artwork/UI, wired up to these
same socket events instead of the local AI engine.
