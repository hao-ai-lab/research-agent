#!/usr/bin/env python3
"""
Generate a secure random token for the Modal API Gateway and update Modal secrets.
"""
import secrets
import string
import subprocess
import sys

def generate_token(length=32):
    """Generate a secure random token."""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))

def update_modal_secret(token):
    """Update or create the gateway-secrets in Modal."""
    print("🔐 updating Modal secret 'gateway-secrets'...")
    
    # First, try to delete if it exists (to avoid errors if updating)
    subprocess.run(
        ["modal", "secret", "delete", "gateway-secrets", "--yes"],
        stderr=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL
    )
    
    # Create the secret
    result = subprocess.run(
        ["modal", "secret", "create", "gateway-secrets", f"GATEWAY_TOKEN={token}"],
        capture_output=True,
        text=True
    )
    
    if result.returncode == 0:
        print("✅ Secret 'gateway-secrets' created/updated successfully.")
    else:
        print(f"❌ Failed to update secret: {result.stderr}")
        sys.exit(1)

def main():
    print("🔑 Generating Gateway Token...")
    token = generate_token()
    
    print(f"\nYour new GATEWAY_TOKEN is:\n")
    print(f"    {token}")
    print(f"\n⚠️  SAVE THIS TOKEN! You will need it for your client configuration.\n")
    
    update_modal_secret(token)
    
    print("\nNext steps:")
    print("1. Update your opencode.json with this token in the 'headers' section")
    print("2. Redeploy your Modal app to pick up the new secret")

if __name__ == "__main__":
    main()
