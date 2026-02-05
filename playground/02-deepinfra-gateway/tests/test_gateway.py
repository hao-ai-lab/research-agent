#!/usr/bin/env python3
"""
Test script for the Modal API Gateway.

Usage:
    # Test against deployed gateway
    python test_gateway.py --url https://YOUR_APP--openai-gateway-chat-completions.modal.run

    # Test against local/dev gateway (if running locally)
    python test_gateway.py --url http://localhost:8000/chat_completions
"""
import argparse
import os
import sys

try:
    import httpx
except ImportError:
    print("httpx not installed. Installing...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "httpx"])
    import httpx


def test_gateway(gateway_url: str, auth_token: str = None):
    """Test the Modal gateway with a simple chat completion request."""
    
    headers = {
        "Content-Type": "application/json",
    }
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    
    payload = {
        "model": "google/gemma-3-27b-it",
        "messages": [
            {"role": "user", "content": "What is 2+2? Answer in one word."}
        ],
        "max_tokens": 50,
        "stream": False,
    }

    print("🚀 Testing Modal API Gateway...")
    print(f"   URL: {gateway_url}")
    print(f"   Model: {payload['model']}")
    print()

    try:
        response = httpx.post(gateway_url, json=payload, headers=headers, timeout=60)
        
        # Check for request ID header (set by gateway)
        request_id = response.headers.get("X-Gateway-Request-Id", "N/A")
        print(f"   Gateway Request ID: {request_id}")
        
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


def test_health(base_url: str):
    """Test the gateway health endpoint."""
    # Construct health URL from chat completions URL
    health_url = base_url.replace("chat-completions", "health")
    
    print(f"🏥 Testing health endpoint: {health_url}")
    try:
        response = httpx.get(health_url, timeout=10)
        response.raise_for_status()
        print(f"   ✅ Health: {response.json()}")
    except Exception as e:
        print(f"   ⚠️ Health check failed: {e}")


def test_models(base_url: str):
    """Test the gateway models endpoint."""
    models_url = base_url.replace("chat-completions", "models")
    
    print(f"📋 Testing models endpoint: {models_url}")
    try:
        response = httpx.get(models_url, timeout=10)
        response.raise_for_status()
        print(f"   ✅ Models: {response.json()}")
    except Exception as e:
        print(f"   ⚠️ Models check failed: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test the Modal API Gateway")
    parser.add_argument("--url", required=True, help="Gateway chat completions URL")
    parser.add_argument("--token", help="Optional auth token")
    
    args = parser.parse_args()
    
    # Test health and models first
    test_health(args.url)
    print()
    test_models(args.url)
    print()
    
    # Test chat completion
    test_gateway(args.url, args.token)
