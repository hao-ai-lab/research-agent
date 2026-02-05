#!/bin/bash
# Test suite for OpenCode models via Modal Gateway
# Usage: ./test_models.sh [optional_prompt]

PROMPT="${1:-Say 'Pass'}"

models=(
    # "my-openai/google/gemini-2.5-flash"
    "my-openai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"
    "my-openai/meta-llama/Meta-Llama-3.1-70B-Instruct"
    "my-openai/Qwen/Qwen2.5-Coder-32B-Instruct"
    "my-openai/deepseek-ai/DeepSeek-V3"
    "my-openai/moonshotai/Kimi-K2.5"
    "my-openai/zai-org/GLM-4.7-Flash"
    "my-openai/MiniMaxAI/MiniMax-M2.1"
    "my-openai/allenai/Olmo-3.1-32B-Instruct"
    # too expensive to test.
    # "my-openai/anthropic/claude-4-opus"
    # "my-openai/anthropic/claude-3-7-sonnet-latest"
    # "my-openai/anthropic/claude-4-sonnet"
    # "my-openai/google/gemini-2.5-pro"
)

echo "🚀 Starting Extended Model Test Suite (13 Models)"
echo "🚀 Prompt: '$PROMPT'"
echo "----------------------------------------"

for model in "${models[@]}"; do
    echo "🧪 Testing: $model"
    # Run opencode and capture output/exit code
    OUTPUT=$(opencode run --model "$model" "$PROMPT" 2>&1)
    EXIT_CODE=$?
    
    # Check for exit code AND error keywords in output
    if [ $EXIT_CODE -eq 0 ] && [[ ! "$OUTPUT" == *"Not Found"* ]] && [[ ! "$OUTPUT" == *"Error:"* ]] && [[ ! "$OUTPUT" == *"error_type"* ]]; then
        echo "✅ Success"
        # Print the last few lines of output to show the response
        echo "$OUTPUT" | tail -n 3
        
        # Check output length (VERY rough check)
        LENGTH=${#OUTPUT}
        if [ $LENGTH -gt 2000 ]; then
             echo "⚠️  Warning: Output seems long ($LENGTH characters)"
        fi
    else
        echo "❌ Failed (Exit Code: $EXIT_CODE)"
        echo "Output:"
        echo "$OUTPUT"
    fi
    echo "----------------------------------------"
    # echo ""
done

echo "🏁 Test Suite Completed"
