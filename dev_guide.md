````md
# Onboarding for Hao’s Capstone Group

This guide walks you through setting up and running the research agent locally, connecting it to OpenCode, and getting ready to work on wishlist items.

---
````


## 1. Clone the Repository

```bash
git clone https://github.com/GindaChen/v0-research-agent-mobile.git

---

## 2. Generate an Auth Token

```bash
cd server
./generate_auth_token.sh --export
```

**Important:**
Save the auth token somewhere safe. You will need it later.

---

## 3. Install OpenCode

```bash
curl -fsSL https://opencode.ai/install | bash
```

---

## 4. Start the Backend + OpenCode (Terminal 1)

From the root of the repo:

```bash
npm install
uv venv .ra-venv
uv pip install --python .ra-venv/bin/python -r server/requirements.txt

export RESEARCH_AGENT_USER_AUTH_TOKEN="$(openssl rand -hex 16)"
export OPENCODE_CONFIG="$(pwd)/server/opencode.json"

opencode serve
```

Leave this terminal running.

---

## 5. Start the Research Agent Server (Terminal 2)

```bash
cd server
../.ra-venv/bin/python server.py --workdir /path/to/your/research/project --port 10000
```

**Note:**
`/path/to/your/research/project` should point to:

```
tests/story/alerts
```

(or wherever your research project lives locally).

---

## 6. Start the Frontend (Terminal 3)

```bash
NEXT_PUBLIC_API_URL=http://127.0.0.1:10000 NEXT_PUBLIC_USE_MOCK=false npm run dev -- --port 3000
```

This will give you a local link hosting the research agent UI.

---

## 7. Connect the UI to the Research Agent

1. Open the link from `localhost:3000`
2. Click the bottom-left menu where **“Research Lab”** is shown
3. Click **Settings**
4. Paste your **AUTH key**
5. Click **Test Connection**

   * Make sure there are **no errors**
6. Confirm you are **NOT** in demo mode

---

## 8. Verify Streaming with OpenCode

OpenCode is the **ground truth** for the research agent, so this step is important.

1. Go to the terminal where you ran:

   ```bash
   opencode serve
   ```
2. Follow the OpenCode link shown in that terminal
3. In OpenCode’s search bar, enter the path where your `localhost:3000` app is running
4. Once inside that path:

   * On the **left sidebar**, you should see every chat conversation you start with the research agent **while OpenCode is running**

If you see the conversations appearing:

* Streaming between the chatbot and OpenCode is working correctly

---

## 9. Working on Wishlist Items

Once everything above is set up:

1. Go to **Issues**
2. Look for items labeled:
   **`(ux) UI and Functional Enhancement`**
3. When you pick a wishlist item:

   * Create a **sub-issue** stating you are taking it
   * Create a **new branch** for that specific item
4. After completing the work:

   * Open a **PR**
   * Assign **Junda** as the reviewer
5. If the PR is approved:

   * **Delete the branch**

---

## 10. Taking Another Wishlist Item

If you want to work on another wishlist item, you must start again from:

```bash
npm install
```

We are actively working on making this process more streamlined so you don’t have to repeat all of these steps every time.

```
```
