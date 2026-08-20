# Matatu — multiplayer server

Server-authoritative Matatu (card game) backend: rooms, a public lobby, and
the game rules engine, all running server-side over Socket.IO so players
can't see each other's hands or force illegal moves.

## Run locally
```
npm install
npm start
```
Then open http://localhost:3000 — this loads a bare-bones test page (not
the real game art yet) so you can confirm rooms/lobby/turns all work.

## Deploy
See DEPLOY.md for the click-by-click Render + GitHub guide.
