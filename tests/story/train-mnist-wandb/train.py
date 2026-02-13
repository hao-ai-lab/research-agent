#!/usr/bin/env python3
"""
MNIST training experiment for testing sidecar + wandb integration.

This script:
- Trains a simple CNN on MNIST using GPU
- Logs metrics via wandb (offline mode for reliability)
- Prints WANDB_RUN_DIR for sidecar detection
- Logs diverse metrics: loss, accuracy, grad norms, lr

Usage (via research-agent sidecar):
    WANDB_MODE=offline CUDA_VISIBLE_DEVICES=2 python train.py --epochs 5

The sidecar will:
1. Detect the WANDB_RUN_DIR from stdout
2. Stream metrics from wandb-history.jsonl to the server
3. The frontend charts will auto-detect and visualize all logged metrics
"""

import argparse
import math
import os
import time

import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.optim as optim
from torch.utils.data import DataLoader
from torchvision import datasets, transforms

try:
    import wandb
    HAS_WANDB = True
except ImportError:
    HAS_WANDB = False
    print("Warning: wandb not installed. Metrics will only be printed to stdout.")


class SimpleCNN(nn.Module):
    """Small CNN for MNIST - fast to train, enough params to be interesting."""

    def __init__(self, dropout: float = 0.25):
        super().__init__()
        self.conv1 = nn.Conv2d(1, 32, 3, padding=1)
        self.conv2 = nn.Conv2d(32, 64, 3, padding=1)
        self.pool = nn.MaxPool2d(2, 2)
        self.dropout1 = nn.Dropout2d(dropout)
        self.fc1 = nn.Linear(64 * 7 * 7, 128)
        self.dropout2 = nn.Dropout(dropout)
        self.fc2 = nn.Linear(128, 10)

    def forward(self, x):
        x = self.pool(F.relu(self.conv1(x)))
        x = self.pool(F.relu(self.conv2(x)))
        x = self.dropout1(x)
        x = x.view(-1, 64 * 7 * 7)
        x = F.relu(self.fc1(x))
        x = self.dropout2(x)
        x = self.fc2(x)
        return x


def compute_grad_norm(model: nn.Module) -> float:
    """Compute global gradient norm."""
    total_norm = 0.0
    for p in model.parameters():
        if p.grad is not None:
            total_norm += p.grad.data.norm(2).item() ** 2
    return math.sqrt(total_norm)


def main():
    parser = argparse.ArgumentParser(description="Train CNN on MNIST with W&B logging.")
    parser.add_argument("--lr", type=float, default=0.001, help="Learning rate")
    parser.add_argument("--batch-size", type=int, default=128, help="Batch size")
    parser.add_argument("--epochs", type=int, default=5, help="Number of epochs")
    parser.add_argument("--dropout", type=float, default=0.25, help="Dropout rate")
    parser.add_argument("--optimizer", type=str, default="adam", choices=["adam", "sgd", "adamw"])
    parser.add_argument("--weight-decay", type=float, default=1e-4, help="Weight decay")
    parser.add_argument("--wandb-project", type=str, default="research-agent-mnist")
    parser.add_argument("--wandb-name", type=str, default=None)
    parser.add_argument("--no-wandb", action="store_true", help="Disable W&B logging")
    parser.add_argument("--data-dir", type=str, default="./data", help="MNIST data directory")
    parser.add_argument("--log-interval", type=int, default=10, help="Log every N batches")
    args = parser.parse_args()

    # Device selection
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")
    if device.type == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"Config: {vars(args)}")

    # W&B init
    wandb_run = None
    if HAS_WANDB and not args.no_wandb:
        # Default to offline mode for reliability
        if "WANDB_MODE" not in os.environ:
            os.environ["WANDB_MODE"] = "offline"

        wandb_run = wandb.init(
            project=args.wandb_project,
            name=args.wandb_name,
            config=vars(args),
        )
        # Print for sidecar detection
        print(f"WANDB_RUN_DIR: {wandb.run.dir}")
        try:
            url = wandb.run.url
            if url:
                print(f"W&B Run URL: {url}")
        except Exception:
            pass

    # Data
    transform = transforms.Compose([
        transforms.ToTensor(),
        transforms.Normalize((0.1307,), (0.3081,)),
    ])
    train_dataset = datasets.MNIST(args.data_dir, train=True, download=True, transform=transform)
    test_dataset = datasets.MNIST(args.data_dir, train=False, transform=transform)
    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True, num_workers=2, pin_memory=True)
    test_loader = DataLoader(test_dataset, batch_size=1000, shuffle=False, num_workers=2, pin_memory=True)

    # Model
    model = SimpleCNN(dropout=args.dropout).to(device)
    param_count = sum(p.numel() for p in model.parameters())
    print(f"Model parameters: {param_count:,}")

    # Optimizer
    if args.optimizer == "adam":
        optimizer = optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    elif args.optimizer == "adamw":
        optimizer = optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    else:
        optimizer = optim.SGD(model.parameters(), lr=args.lr, momentum=0.9, weight_decay=args.weight_decay)

    criterion = nn.CrossEntropyLoss()

    # Training loop
    print("\nStarting training...")
    start_time = time.time()
    global_step = 0

    for epoch in range(1, args.epochs + 1):
        model.train()
        epoch_loss = 0.0
        epoch_correct = 0
        epoch_total = 0

        for batch_idx, (data, target) in enumerate(train_loader):
            data, target = data.to(device), target.to(device)

            optimizer.zero_grad()
            output = model(data)
            loss = criterion(output, target)
            loss.backward()

            grad_norm = compute_grad_norm(model)
            optimizer.step()

            global_step += 1
            batch_loss = loss.item()
            epoch_loss += batch_loss
            pred = output.argmax(dim=1)
            correct = pred.eq(target).sum().item()
            epoch_correct += correct
            epoch_total += len(target)

            # Log per-step metrics
            if wandb_run and (batch_idx % args.log_interval == 0):
                wandb.log({
                    "train/loss": batch_loss,
                    "train/accuracy": correct / len(target),
                    "train/grad_norm": grad_norm,
                    "train/lr": optimizer.param_groups[0]["lr"],
                    "train/step": global_step,
                    "epoch": epoch,
                }, step=global_step)

            if batch_idx % (args.log_interval * 5) == 0:
                print(f"  Epoch {epoch} [{batch_idx * len(data)}/{len(train_loader.dataset)}] "
                      f"Loss: {batch_loss:.4f} Acc: {correct / len(target):.3f}")

        # Epoch-level metrics
        avg_train_loss = epoch_loss / len(train_loader)
        train_accuracy = epoch_correct / epoch_total

        # Validation
        model.eval()
        val_loss = 0.0
        val_correct = 0
        with torch.no_grad():
            for data, target in test_loader:
                data, target = data.to(device), target.to(device)
                output = model(data)
                val_loss += criterion(output, target).item()
                pred = output.argmax(dim=1)
                val_correct += pred.eq(target).sum().item()

        avg_val_loss = val_loss / len(test_loader)
        val_accuracy = val_correct / len(test_dataset)

        print(f"Epoch {epoch}/{args.epochs} - "
              f"Train Loss: {avg_train_loss:.4f}, Train Acc: {train_accuracy:.4f}, "
              f"Val Loss: {avg_val_loss:.4f}, Val Acc: {val_accuracy:.4f}")

        if wandb_run:
            wandb.log({
                "train/epoch_loss": avg_train_loss,
                "train/epoch_accuracy": train_accuracy,
                "val/loss": avg_val_loss,
                "val/accuracy": val_accuracy,
                "epoch": epoch,
            }, step=global_step)

    elapsed = time.time() - start_time
    print(f"\nTraining completed in {elapsed:.1f}s")
    print(f"Final - Val Loss: {avg_val_loss:.4f}, Val Acc: {val_accuracy:.4f}")

    if wandb_run:
        wandb.log({
            "final/val_loss": avg_val_loss,
            "final/val_accuracy": val_accuracy,
            "final/training_time_seconds": elapsed,
        })
        wandb.finish()
        print("W&B run finished.")


if __name__ == "__main__":
    main()
