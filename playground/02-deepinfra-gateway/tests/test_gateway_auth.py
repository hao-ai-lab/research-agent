#!/usr/bin/env python3
import argparse
import sys
import httpx
import os

def test_auth(url, correct_token):
    print(f"🔒 Testing Authentication for {url}")
    print(f"Token: {correct_token[:4]}...{correct_token[-4:]} (from {'env var HAOAILABKEY' if os.environ.get('HAOAILABKEY') == correct_token else 'args'})")
    print("-" * 50)
    
    # 1. Missing Token
    print("1. Testing Missing Token...", end=" ")
    try:
        response = httpx.post(f"{url}/chat/completions", json={"model": "test"}, timeout=10)
        if response.status_code == 401:
            print("✅ Passed (401 Unauthorized)")
        else:
            print(f"❌ Failed (Got {response.status_code})")
    except Exception as e:
        print(f"❌ Error: {e}")

    # 2. Invalid Token
    print("2. Testing Invalid Token...", end=" ")
    try:
        headers = {"Authorization": "Bearer invalid_token_123"}
        response = httpx.post(f"{url}/chat/completions", json={"model": "test"}, headers=headers, timeout=10)
        if response.status_code == 401:
            print("✅ Passed (401 Unauthorized)")
        else:
            print(f"❌ Failed (Got {response.status_code})")
    except Exception as e:
        print(f"❌ Error: {e}")

    # 3. Valid Token
    print("3. Testing Valid Token...", end=" ")
    try:
        headers = {"Authorization": f"Bearer {correct_token}"}
        # Use a minimal valid payload
        payload = {
            "model": "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
            "messages": [{"role": "user", "content": "Hi"}],
            "max_tokens": 5
        }
        response = httpx.post(f"{url}/chat/completions", json=payload, headers=headers, timeout=30)
        
        if response.status_code == 200:
            print("✅ Passed (200 OK)")
            print(f"   Response: {response.json().get('choices', [{}])[0].get('message', {}).get('content')}")
        else:
            print(f"❌ Failed (Got {response.status_code})")
            print(f"   Error: {response.text}")
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test authentication")
    parser.add_argument("--url", help="Gateway Base URL (e.g. https://.../v1)")
    parser.add_argument("--token", help="Correct Gateway Token")
    args = parser.parse_args()
    
    token = args.token or os.environ.get("HAOAILABKEY")
    if not token:
        print("❌ Error: Token must be provided via --token or HAOAILABKEY env var")
        sys.exit(1)
        
    url = args.url or "https://hao-ai-lab--openai-gateway-v2-api.modal.run/v1"
    
    test_auth(url, token)
