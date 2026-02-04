import requests
import os
from typing import List
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich import print as rprint

BASE_URL = "http://127.0.0.1:10000"
console = Console()

def test_root():
    response = requests.get(f"{BASE_URL}/")
    rprint(Panel(f"[bold green]Root Check:[/bold green] {response.json()}", title="Server Status"))

def test_create_sweep():
    sweep_data = {
        "name": "mnist_hyperopt",
        "runs": [
            {"name": "lr_0.01", "command": "echo 'training lr 0.01'; sleep 5", "params": {"lr": 0.01}},
            {"name": "lr_0.001", "command": "echo 'training lr 0.001'; sleep 5", "params": {"lr": 0.001}}
        ]
    }
    response = requests.post(f"{BASE_URL}/sweeps", json=sweep_data)
    data = response.json()
    rprint(Panel(f"[bold blue]Sweep Created:[/bold blue] {data.get('message')}\nID: {data.get('sweep_id')}", title="Create Sweep"))
    return data.get("sweep_id")

def test_create_run():
    run_data = {
        "name": "adhoc_bash",
        "command": "echo 'running adhoc command'; sleep 5",
        "params": {"type": "adhoc"},
        "expname": "debug_session"
    }
    response = requests.post(f"{BASE_URL}/runs", json=run_data)
    data = response.json()
    rprint(Panel(f"[bold cyan]Run Started:[/bold cyan] {data.get('message')}\nTmux: {data.get('tmux_window')}", title="Create Run"))
    return data.get("job_id")

def list_sweeps():
    response = requests.get(f"{BASE_URL}/sweeps")
    sweeps = response.json()
    
    table = Table(title="Existing Sweeps")
    table.add_column("Sweep ID", style="magenta")
    table.add_column("Name", style="green")
    table.add_column("Runs Count", style="cyan")
    
    for sid, sdata in sweeps.items():
        table.add_row(sid, sdata["name"], str(len(sdata["run_ids"])))
    
    console.print(table)
    return list(sweeps.keys())

def list_runs(sweep_id=None):
    if sweep_id:
        url = f"{BASE_URL}/sweeps/{sweep_id}/runs"
        title = f"Runs for Sweep: {sweep_id}"
    else:
        url = f"{BASE_URL}/runs"
        title = "All Registered Runs"
        
    response = requests.get(url)
    runs = response.json()
    
    table = Table(title=title)
    table.add_column("Job ID", style="magenta")
    table.add_column("Name", style="green")
    table.add_column("Exp Name", style="yellow")
    table.add_column("Status", style="bold")
    table.add_column("Tmux Window", style="blue")
    
    for rid, rdata in runs.items():
        status_style = "green" if rdata["status"] == "running" else "yellow"
        table.add_row(
            rid[:8] + "...", 
            rdata["name"], 
            rdata.get("expname", "N/A"),
            f"[{status_style}]{rdata['status']}[/]",
            rdata.get("tmux_window", "N/A")
        )
    
    console.print(table)

def test_deferred_sweep():
    console.print(Panel("Testing Deferred Sweep Creation", style="bold magenta"))
    
    # Path to the test instance configs
    config_path = "/global/homes/j/jundac/project/research-agent/playground2/3-master-agent-gui-p3/tests/instances/test01-train-gpt2/.agents/configs.json"
    workdir = os.path.dirname(os.path.dirname(config_path))
    
    import json
    with open(config_path, 'r') as f:
        config_data = json.load(f)
    
    # Add workdir to each run
    for run in config_data["runs"]:
        run["workdir"] = workdir
        
    config_data["auto_start"] = False
    
    response = requests.post(f"{BASE_URL}/sweeps", json=config_data)
    if response.status_code == 200:
        data = response.json()
        sweep_id = data["sweep_id"]
        run_ids = data["run_ids"]
        rprint(f"[green]Sweep '{config_data['name']}' registered (ID: {sweep_id})[/green]")
        rprint(f"Runs: {run_ids}")
        return sweep_id, run_ids
    else:
        rprint(f"[red]Failed to create sweep: {response.text}[/red]")
        return None, None

def test_start_run(job_id):
    console.print(Panel(f"Starting Job: {job_id}", style="bold blue"))
    response = requests.post(f"{BASE_URL}/runs/{job_id}/start")
    if response.status_code == 200:
        rprint(f"[green]Successfully started {job_id}[/green]")
        rprint(response.json())
    else:
        rprint(f"[red]Failed to start {job_id}: {response.text}[/red]")

def test_monitor_runs(target_run_ids: List[str]):
    console.print(Panel("Monitoring Jobs Until Completion", style="bold yellow"))
    
    import time
    from rich.live import Live
    
    def generate_status_table():
        response = requests.get(f"{BASE_URL}/runs")
        if response.status_code != 200:
            return Text(f"Error fetching runs: {response.text}", style="red")
        
        all_jobs = response.json()
        table = Table(title="Job Monitoring Status")
        table.add_column("Job ID", style="cyan")
        table.add_column("Slurm ID", style="magenta")
        table.add_column("Name", style="white")
        table.add_column("Status", style="bold")
        table.add_column("Tmux Window", style="blue")
        
        finished_count = 0
        for rid in target_run_ids:
            job = all_jobs.get(rid)
            if not job:
                table.add_row(rid, "-", "Unknown", "Not Found", "")
                continue
                
            status = job.get("status", "unknown")
            slurm_id = job.get("slurm_id") or "-"
            color = "white"
            if status == "running": color = "green"
            elif status == "launching": color = "cyan"
            elif status == "pending": color = "yellow"
            elif status == "finished": 
                color = "blue"
                finished_count += 1
            elif status in ["failed", "killed"]: 
                color = "red"
                finished_count += 1
                
            table.add_row(rid, slurm_id, job.get("name"), f"[{color}]{status}[/{color}]", job.get("tmux_window"))
        
        return table, finished_count == len(target_run_ids)

    with Live(generate_status_table()[0], refresh_per_second=1) as live:
        while True:
            table, all_finished = generate_status_table()
            live.update(table)
            if all_finished:
                break
            time.sleep(2)
            
    console.print("[bold green]All monitored jobs have finished![/bold green]")

if __name__ == "__main__":
    try:
        test_root()
        
        sweep_id, run_ids = test_deferred_sweep()
        if run_ids:
            # Start all runs in the sweep
            console.print(f"[bold cyan]Launching {len(run_ids)} jobs from sweep {sweep_id}...[/bold cyan]")
            for rid in run_ids:
                test_start_run(rid)
            
            # Monitor until they finish
            test_monitor_runs(run_ids)
            
            # Final listing
            list_runs()
            
    except requests.exceptions.ConnectionError:
        rprint("[bold red]Error:[/bold red] Could not connect to server. Is it running?")
    except Exception as e:
        rprint(f"[bold red]An error occurred:[/bold red] {e}")
