# DeepInfra API Gateway

OpenAI-compatible API gateway that logs requests and forwards to DeepInfra.

## Quick Start

```bash
modal deploy modal_gateway.py 
sleep 5
# export HAOAILABKEY=...
python tests/test_gateway_auth.py 
opencode run --model my-openai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo "hi"
```

## Detail Setup

### 1. Test DeepInfra Direct
```bash
export DEEPINFRA_TOKEN=your_api_key
python test_deepinfra.py
```

### 2. Deploy Modal Gateway
```bash
# Make sure Modal secrets are configured:
# modal secret create deepinfra-secrets DEEPINFRA_TOKEN=your_api_key

modal deploy modal_gateway.py
```

### 3. Test Gateway
```bash
python test_gateway.py --url https://YOUR_APP--openai-gateway-chat-completions.modal.run
```
in our case
```bash
python test_gateway.py --url https://hao-ai-lab--openai-gateway-v2-api.modal.run
```

### 4. Supported Models
The following models are pre-configured in `opencode.json` and supported by the gateway:
- `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo`
- `meta-llama/Meta-Llama-3.1-70B-Instruct`
- `Qwen/Qwen2.5-Coder-32B-Instruct`
- `deepseek-ai/DeepSeek-V3`
- `moonshotai/Kimi-K2.5`
- `zai-org/GLM-4.7-Flash`
- `MiniMaxAI/MiniMax-M2.1`
- `allenai/Olmo-3.1-32B-Instruct`
- `anthropic/claude-4-opus`
- `anthropic/claude-3-7-sonnet-latest`
- `anthropic/claude-4-sonnet`

### 5. Running Tests
We provide a standard test suite to verify all configured models:

```bash
# Ensure your key is set
export HAOAILABKEY=...

# Run the test suite
./tests/test_opencode_models.sh "Say 'Refactored'"
```

## Files
- `opencode.json` - OpenCode config for direct DeepInfra
- `modal_gateway.py` - Modal API gateway
- `test_deepinfra.py` - Test DeepInfra API directly
- `test_gateway.py` - Test the Modal gateway


