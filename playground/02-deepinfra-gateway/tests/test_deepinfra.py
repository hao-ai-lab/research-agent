#!/usr/bin/env python3
"""
Test script to verify DeepInfra API connectivity with Gemma 3 27B.

Usage:
    export DEEPINFRA_TOKEN=your_api_key
    python test_deepinfra.py
"""
import os
import sys

try:
    import httpx
except ImportError:
    print("httpx not installed. Installing...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "httpx"])
    import httpx


def test_deepinfra():
    token = os.environ.get("DEEPINFRA_TOKEN")
    if not token:
        print("❌ Error: DEEPINFRA_TOKEN environment variable not set")
        print("   Get your API key from: https://deepinfra.com/dash")
        sys.exit(1)

    url = "https://api.deepinfra.com/v1/openai/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}"
    }
    payload = {
        "model": "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
        "messages": [{"role": "user", "content": "Say hello in a creative way!"}],
        "max_tokens": 100
    }

    print("🚀 Testing DeepInfra API with Gemma 3 27B...")
    print(f"   URL: {url}")
    print(f"   Model: {payload['model']}")
    print()

    try:
        response = httpx.post(url, json=payload, headers=headers, timeout=30)
        response.raise_for_status()
        
        data = response.json()
        
        print("✅ Success!")
        print()
        print("Response:")
        print("-" * 40)
        
        if "choices" in data and len(data["choices"]) > 0:
            message = data["choices"][0].get("message", {})
            content = message.get("content", "No content")
            print(content)
        else:
            print(data)
            
        print("-" * 40)
        print()
        
        # Print usage info
        if "usage" in data:
            usage = data["usage"]
            print(f"Tokens used: {usage.get('total_tokens', 'N/A')} "
                  f"(prompt: {usage.get('prompt_tokens', 'N/A')}, "
                  f"completion: {usage.get('completion_tokens', 'N/A')})")
                  
    except httpx.HTTPStatusError as e:
        print(f"❌ HTTP Error: {e.response.status_code}")
        print(f"   Response: {e.response.text}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    test_deepinfra()
