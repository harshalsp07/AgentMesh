# AgentMesh Universal Multi-Platform Publishing & Deployment Guide

AgentMesh is architected for zero-friction production publishing across all major modern cloud and hosting platforms.

---

## 1. Dual-Engine Architecture: How It Works Anywhere

The AgentMesh production web application (`site/`) operates with a **dual-mode engine**:

1. **Connected Hub Mode (Live Stream)**:
   - When connected to a local or remote AgentMesh daemon (`:7777`), the site establishes real-time Server-Sent Events (`/events`), polls the UI overview (`/api/overview`), exchanges CRDT deltas (`/api/crdt`), and coordinates P2P WebRTC signaling.
   - Ideal for private teams, internal Kubernetes/Docker clusters, and developer environments.

2. **Standalone / Interactive Swarm Simulator Mode**:
   - When deployed statically on **Vercel**, **Netlify**, **Cloudflare Pages**, or **GitHub Pages**, visitors without a local hub running do not encounter a blank screen or 404 errors.
   - The site automatically launches an interactive in-browser **Multi-Agent Swarm Simulator** modeling 4 autonomous agents (`frontend-agent`, `backend-agent`, `schema-steward`, `security-auditor`), live AST Semantic CRDT merging, MACP quorum voting, collision negotiation ladders, and P2P WebRTC DataChannel connectivity!
   - Visitors can click **Connect Hub** in the header at any time to stream live data from their own self-hosted AgentMesh instance using an Ed25519 token.

---

## 2. Platform-by-Platform Publishing Instructions

### A. Vercel
AgentMesh includes a preconfigured [`vercel.json`](file:///home/harshal/Project/vercel.json) specifying `site` as the output directory with security headers and client routing rewrites.

```bash
# 1. Install or run Vercel CLI
npx vercel

# 2. Deploy to production
npx vercel --prod
```
- **Zero Configuration**: Vercel automatically detects `vercel.json` and serves `site/` globally on the Vercel Edge Network.

---

### B. Netlify
AgentMesh includes [`netlify.toml`](file:///home/harshal/Project/netlify.toml) with SPA redirect fallbacks and caching headers.

```bash
# 1. Install or run Netlify CLI
npx netlify deploy

# 2. Deploy to production
npx netlify deploy --prod --dir=site
```

---

### C. Cloudflare Pages & Workers
AgentMesh includes [`wrangler.toml`](file:///home/harshal/Project/wrangler.toml) and an edge worker [`site/_worker.js`](file:///home/harshal/Project/site/_worker.js).

```bash
# Deploy directory directly to Cloudflare Pages
npx wrangler pages deploy site --project-name=agentmesh
```

---

### D. GitHub Pages (Free Automated Hosting)
AgentMesh includes a native GitHub Actions workflow in [`.github/workflows/deploy-pages.yml`](file:///home/harshal/Project/.github/workflows/deploy-pages.yml).

1. Push your repository to GitHub:
   ```bash
   git add .
   git commit -m "feat: production multi-platform agentmesh"
   git push origin main
   ```
2. In your repository settings:
   - Go to **Settings** $\to$ **Pages**.
   - Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. On every push to `main`, GitHub Pages will automatically build and publish your site!

---

### E. Docker Container (Self-Hosted / VPS / Fly.io / GCP Cloud Run)
The production [`Dockerfile`](file:///home/harshal/Project/Dockerfile) bundles both the Node 22 backend daemon and the production web application on a single port with health checks (`/ready`):

```bash
# 1. Build the production container
docker build -t agentmesh:latest .

# 2. Run container (maps port 7777 and mounts persistent data volume)
docker run -d \
  --name agentmesh \
  -p 7777:7777 \
  -v mesh-data:/data \
  agentmesh:latest

# 3. Open browser
open http://localhost:7777/
```

---

### F. Render (1-Click Blueprint)
AgentMesh includes [`render.yaml`](file:///home/harshal/Project/render.yaml) specifying a persistent 1GB disk, Docker runtime, and `/ready` health check.
1. Connect your GitHub repository to [Render.com](https://render.com).
2. Choose **Blueprints** and select `render.yaml`.
3. Render automatically provisions the daemon, mounts `/data`, and assigns a free SSL domain.

---

### G. Railway (1-Click Deployment)
AgentMesh includes [`railway.json`](file:///home/harshal/Project/railway.json).
```bash
# Deploy with Railway CLI
npm install -g @railway/cli
railway up
```

---

## 3. Automated Readiness Verification

Run the built-in publishing doctor at any time to verify that all 18 platform configurations and sync modules are 100% compliant:

```bash
npm run publish:check
# or
node scripts/publish-check.mjs
```

Expected output:
```text
=== AgentMesh Universal Platform Publishing Readiness Doctor ===
✅ [OK] Production Web App: index.html
✅ [OK] Design System: style.css
✅ [OK] Client Engine: app.js
✅ [OK] PWA Web Manifest
✅ [OK] Offline Service Worker
✅ [OK] Vercel Deployment Config
✅ [OK] Netlify Deployment Config
✅ [OK] Cloudflare Pages Config
✅ [OK] Cloudflare Edge Worker
✅ [OK] GitHub Pages CI/CD Action
✅ [OK] Docker Production Container
✅ [OK] Render 1-Click Blueprint
✅ [OK] Railway Deployment Schema
✅ [OK] Semantic CRDT Engine
✅ [OK] MACP 5-Mode Kernel
✅ [OK] Epistemic Merkle DAG
✅ [OK] P2P WebRTC Swarm Signaling
✅ [OK] Google A2A Standard Gateway
--------------------------------------------------------------
🎉 ALL 18 PRODUCTION DEPLOYMENT & SYNC CHECKS PASSED!
```
