import argparse
import time

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset


def main():
    parser = argparse.ArgumentParser(description="Train a simple MLP on CPU with synthetic data.")

    # Hyperparameters exposed in args
    parser.add_argument("--lr", type=float, default=0.001, help="Learning rate (default: 0.001)")
    parser.add_argument("--batch-size", type=int, default=32, help="Batch size for training (default: 32)")
    parser.add_argument("--epochs", type=int, default=10, help="Number of training epochs (default: 10)")
    parser.add_argument("--hidden-size", type=int, default=64, help="Size of hidden layer (default: 64)")
    parser.add_argument("--input-size", type=int, default=10, help="Dimension of input features (default: 10)")
    parser.add_argument("--output-size", type=int, default=1, help="Dimension of output (default: 1)")
    parser.add_argument("--samples", type=int, default=1000, help="Number of synthetic samples (default: 1000)")

    args = parser.parse_args()

    # Force CPU
    device = torch.device("cpu")
    print(f"Using device: {device}")
    print(f"Hyperparameters: {vars(args)}")

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
        nn.Linear(args.hidden_size, args.output_size),
    ).to(device)

    # 3. Define Optimizer and Loss Function
    optimizer = optim.Adam(model.parameters(), lr=args.lr)
    criterion = nn.MSELoss()

    # 4. Training Loop
    print("\nStarting training...")
    start_time = time.time()

    avg_loss = 0.0
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

        avg_loss = epoch_loss / len(dataloader)
        if epoch % max(1, args.epochs // 10) == 0 or epoch == 1:
            print(f"Epoch {epoch}/{args.epochs} - Loss: {avg_loss:.6f}")

    end_time = time.time()
    print(f"\nTraining completed in {end_time - start_time:.2f} seconds.")
    print("Final Average Loss:", avg_loss)


if __name__ == "__main__":
    main()
