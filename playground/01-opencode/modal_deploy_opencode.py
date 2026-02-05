import modal
import os
import subprocess
import time

# Define the image with necessary dependencies and OpenCode installation
image = (
    modal.Image.debian_slim()
    .apt_install("curl", "gnupg", "unzip", "ca-certificates")
    .run_commands(
        "curl -fsSL https://opencode.ai/install | bash",
        # Verify installation path
        "find / -name opencode -type f -executable"
    )
)

app = modal.App("opencode-server")

@app.function(
    image=image,
    secrets=[modal.Secret.from_name("deepinfra-secrets")], 
    cpu=1.0,  # Adjust as needed
    timeout=3600  # 1 hour timeout
)
@modal.web_server(port=4096, startup_timeout=300)
def serve():
    # The standard path for the binary installed via the script
    opencode_path = "/root/.opencode/bin/opencode"
    
    # Environment setup
    env = os.environ.copy()
    
    # Default model configuration
    # Using kimi-k2.5-free as a cost-effective default, can be changed
    env["DEFAULT_MODEL"] = "kimi-k2.5-free"
    
    # # Map DeepInfra keys if available in secrets
    # if "DEEPINFRA_API_KEY" in env:
    #      env["DEEPINFRA_TOKEN"] = env["DEEPINFRA_API_KEY"]
    #      # Some tools might look for DEEPINFRA_KEY
    #      env["DEEPINFRA_KEY"] = env["DEEPINFRA_API_KEY"]

    print(f"Starting OpenCode server from {opencode_path}...")
    
    # Command to start the server
    # listening on all interfaces (0.0.0.0) is required for Modal web serving
    cmd = [opencode_path, "serve", "--port", "4096", "--hostname", "0.0.0.0"]
    
    # Run the server
    subprocess.Popen(cmd, env=env)
