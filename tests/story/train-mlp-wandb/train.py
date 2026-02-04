import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset
import argparse
import time
import os

# Try to import wandb
try:
    import wandb
    HAS_WANDB = True
except ImportError:
    HAS_WANDB = False
    print("Warning: wandb not installed. Metrics will only be printed.")

def main():
    parser = argparse.ArgumentParser(description="Train a simple MLP on CPU with W&B logging.")
    
    # Hyperparameters exposed in args
    parser.add_argument("--lr", type=float, default=0.001, help="Learning rate (default: 0.001)")
    parser.add_argument("--batch-size", type=int, default=32, help="Batch size for training (default: 32)")
    parser.add_argument("--epochs", type=int, default=10, help="Number of training epochs (default: 10)")
    parser.add_argument("--hidden-size", type=int, default=64, help="Size of hidden layer (default: 64)")
    parser.add_argument("--input-size", type=int, default=10, help="Dimension of input features (default: 10)")
    parser.add_argument("--output-size", type=int, default=1, help="Dimension of output (default: 1)")
    parser.add_argument("--samples", type=int, default=1000, help="Number of synthetic samples (default: 1000)")
    parser.add_argument("--wandb-project", type=str, default="research-agent-mlp", help="W&B project name")
    parser.add_argument("--wandb-name", type=str, default=None, help="W&B run name (auto-generated if not set)")
    parser.add_argument("--no-wandb", action="store_true", help="Disable W&B logging")
    
    args = parser.parse_args()

    # Force CPU
    device = torch.device("cpu")
    print(f"Using device: {device}")
    print(f"Hyperparameters: {vars(args)}")

    # Initialize W&B
    wandb_run = None
    if HAS_WANDB and not args.no_wandb:
        wandb_run = wandb.init(
            project=args.wandb_project,
            name=args.wandb_name,
            config={
                "learning_rate": args.lr,
                "batch_size": args.batch_size,
                "epochs": args.epochs,
                "hidden_size": args.hidden_size,
                "input_size": args.input_size,
                "output_size": args.output_size,
                "samples": args.samples,
                "device": str(device),
            }
        )
        # Print W&B run directory for sidecar detection
        print(f"WANDB_RUN_DIR: {wandb.run.dir}")
        print(f"W&B Run URL: {wandb.run.get_url()}")

    # 1. Create Synthetic Dataset (Regression task)
    X = torch.randn(args.samples, args.input_size)
    # Simple linear relationship with some noise: y = X * Weights + noise
    true_weights = torch.randn(args.input_size, args.output_size)
    y = X @ true_weights + torch.randn(args.samples, args.output_size) * 0.1
    
    dataset = TensorDataset(X, y)
    dataloader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True)

    # 2. Define MLP Model
    model = nn.Sequential(
        nn.Linear(args.input_size, args.hidden_size),
        nn.ReLU(),
        nn.Linear(args.hidden_size, args.hidden_size),
        nn.ReLU(),
        nn.Linear(args.hidden_size, args.output_size)
    ).to(device)

    # 3. Define Optimizer and Loss Function
    optimizer = optim.Adam(model.parameters(), lr=args.lr)
    criterion = nn.MSELoss()

    # 4. Training Loop
    print("\nStarting training...")
    start_time = time.time()
    
    global_step = 0
    for epoch in range(1, args.epochs + 1):
        epoch_loss = 0.0
        for batch_idx, (data, target) in enumerate(dataloader):
            data, target = data.to(device), target.to(device)
            
            optimizer.zero_grad()
            output = model(data)
            loss = criterion(output, target)
            loss.backward()
            optimizer.step()
            
            epoch_loss += loss.item()
            global_step += 1
            
            # Log per-step metrics to W&B
            if wandb_run:
                wandb.log({
                    "train/loss": loss.item(),
                    "train/step": global_step,
                }, step=global_step)
        
        avg_loss = epoch_loss / len(dataloader)
        
        # Log epoch-level metrics
        if wandb_run:
            wandb.log({
                "epoch": epoch,
                "train/epoch_loss": avg_loss,
            }, step=global_step)
        
        # Print progress
        if epoch % max(1, args.epochs // 10) == 0 or epoch == 1:
            print(f"Epoch {epoch}/{args.epochs} - Loss: {avg_loss:.6f}")

    end_time = time.time()
    training_time = end_time - start_time
    print(f"\nTraining completed in {training_time:.2f} seconds.")
    print(f"Final Average Loss: {avg_loss:.6f}")
    
    # Log final summary
    if wandb_run:
        wandb.log({
            "final/loss": avg_loss,
            "final/training_time_seconds": training_time,
        })
        wandb.finish()
        print("W&B run finished successfully.")

if __name__ == "__main__":
    main()
