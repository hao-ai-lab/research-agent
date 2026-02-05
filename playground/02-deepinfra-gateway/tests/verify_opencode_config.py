import json
import os
import httpx
import sys

def verify_config():
    # 1. Read the config file
    try:
        with open("opencode.json", "r") as f:
            config = json.load(f)
        print("✅ Found and parsed opencode.json")
    except FileNotFoundError:
        print("❌ opencode.json not found")
        return
    except json.JSONDecodeError:
        print("❌ Invalid JSON in opencode.json")
        return

    # 2. Extract DeepInfra Token
    # opencode.json uses "{env:DEEPINFRA_TOKEN}"
    # We simulate OpenCode's env var substitution
    provider_config = config.get("provider", {}).get("deepinfra", {})
    api_key_ref = provider_config.get("options", {}).get("apiKey", "")
    
    if api_key_ref == "{env:DEEPINFRA_TOKEN}":
        api_key = os.environ.get("DEEPINFRA_TOKEN")
        if not api_key:
            print("❌ DEEPINFRA_TOKEN env var is not set")
            return
        print("✅ Resolved API Key from environment")
    else:
        print(f"❌ Unexpected apiKey format: {api_key_ref}")
        return

    # 3. Extract Base URL
    base_url = provider_config.get("options", {}).get("baseURL")
    if not base_url:
        print("❌ baseURL missing in config")
        return
    print(f"✅ Base URL: {base_url}")

    # 4. Extract Model
    models = provider_config.get("models", {})
    # Get the first available model key (should be Llama 3.1)
    model_id = next(iter(models), None)
    if not model_id:
        print("❌ No models configured")
        return
    print(f"✅ Model ID: {model_id}")

    # 5. Verify against API
    print("\n🚀 Sending verification request...")
    
    chat_url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": "Confirm you are " + model_id}],
        "max_tokens": 50
    }
    
    try:
        response = httpx.post(chat_url, json=payload, headers=headers, timeout=30)
        if response.status_code == 200:
            print("✅ API Request Successful!")
            print("-" * 40)
            print(f"Response: {response.json()['choices'][0]['message']['content']}")
            print("-" * 40)
            print("\n🎉 CONCLUSION: opencode.json contains a valid configuration.")
        else:
            print(f"❌ API Request Failed: {response.status_code}")
            print(response.text)
    except Exception as e:
        print(f"❌ Request Error: {e}")

if __name__ == "__main__":
    verify_config()
