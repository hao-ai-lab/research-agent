"""
GPU Resource Manager

Tracks and manages GPU resources across the cluster.
Handles allocation, deallocation, and monitoring of GPU devices.
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from enum import Enum

logger = logging.getLogger("gpu-resource-manager")


class GPUStatus(str, Enum):
    """GPU allocation status"""
    AVAILABLE = "available"
    ALLOCATED = "allocated"
    OFFLINE = "offline"
    ERROR = "error"


@dataclass
class GPUResource:
    """Represents a single GPU device"""
    node_id: str
    gpu_id: int
    memory_total_gb: float
    memory_available_gb: float
    utilization_percent: float = 0.0
    temperature_celsius: Optional[float] = None
    status: GPUStatus = GPUStatus.AVAILABLE
    allocated_to: Optional[str] = None  # job_id if allocated
    allocated_at: Optional[float] = None
    
    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization"""
        return {
            "node_id": self.node_id,
            "gpu_id": self.gpu_id,
            "memory_total_gb": self.memory_total_gb,
            "memory_available_gb": self.memory_available_gb,
            "utilization_percent": self.utilization_percent,
            "temperature_celsius": self.temperature_celsius,
            "status": self.status.value,
            "allocated_to": self.allocated_to,
            "allocated_at": self.allocated_at,
        }


@dataclass
class NodeResources:
    """Resources available on a single node"""
    node_id: str
    hostname: str
    gpu_count: int
    gpu_type: str = "H100"
    gpus: List[GPUResource] = field(default_factory=list)
    last_updated: float = field(default_factory=time.time)
    
    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization"""
        return {
            "node_id": self.node_id,
            "hostname": self.hostname,
            "gpu_count": self.gpu_count,
            "gpu_type": self.gpu_type,
            "gpus": [gpu.to_dict() for gpu in self.gpus],
            "last_updated": self.last_updated,
        }


@dataclass
class GPUAllocation:
    """Represents a GPU allocation for a job"""
    job_id: str
    gpus: List[GPUResource]
    allocated_at: float
    user: Optional[str] = None
    
    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization"""
        return {
            "job_id": self.job_id,
            "gpus": [gpu.to_dict() for gpu in self.gpus],
            "allocated_at": self.allocated_at,
            "user": self.user,
        }


class ResourceManager:
    """
    Manages GPU resources across the cluster.
    
    Responsibilities:
    - Track available GPU resources
    - Allocate GPUs to jobs
    - Release GPUs when jobs complete
    - Monitor GPU utilization
    """
    
    def __init__(self):
        self.nodes: Dict[str, NodeResources] = {}
        self.allocations: Dict[str, GPUAllocation] = {}
        
    def initialize_cluster(self, node_count: int = 2, gpus_per_node: int = 8) -> None:
        """
        Initialize cluster with mock GPU resources.
        
        For production, this would query actual cluster state.
        """
        logger.info(f"Initializing cluster: {node_count} nodes, {gpus_per_node} GPUs per node")
        
        for node_idx in range(node_count):
            node_id = f"gmi-node-{node_idx + 1}"
            hostname = f"gmi-{node_idx + 1}.cluster.local"
            
            gpus = []
            for gpu_idx in range(gpus_per_node):
                gpu = GPUResource(
                    node_id=node_id,
                    gpu_id=gpu_idx,
                    memory_total_gb=80.0,  # H100 80GB
                    memory_available_gb=80.0,
                    utilization_percent=0.0,
                    status=GPUStatus.AVAILABLE,
                )
                gpus.append(gpu)
            
            node = NodeResources(
                node_id=node_id,
                hostname=hostname,
                gpu_count=gpus_per_node,
                gpu_type="H100",
                gpus=gpus,
            )
            
            self.nodes[node_id] = node
            
        logger.info(f"Cluster initialized with {len(self.nodes)} nodes and {self.get_total_gpu_count()} GPUs")
    
    def get_available_gpus(self, count: int, memory_gb: float = 0) -> List[GPUResource]:
        """
        Find available GPUs that meet the requirements.
        
        Args:
            count: Number of GPUs required
            memory_gb: Minimum memory required per GPU (0 = any)
            
        Returns:
            List of available GPUs or empty list if not enough available
        """
        available = []
        
        for node in self.nodes.values():
            for gpu in node.gpus:
                if (gpu.status == GPUStatus.AVAILABLE and 
                    gpu.memory_available_gb >= memory_gb):
                    available.append(gpu)
                    
                if len(available) >= count:
                    return available[:count]
        
        return []
    
    def allocate_gpus(self, job_id: str, gpus: List[GPUResource], user: Optional[str] = None) -> bool:
        """
        Allocate GPUs to a job.
        
        Args:
            job_id: Job identifier
            gpus: List of GPUs to allocate
            user: User who owns the job
            
        Returns:
            True if allocation successful, False otherwise
        """
        # Verify all GPUs are still available
        for gpu in gpus:
            if gpu.status != GPUStatus.AVAILABLE:
                logger.warning(f"GPU {gpu.node_id}:{gpu.gpu_id} not available for allocation")
                return False
        
        # Perform allocation
        now = time.time()
        for gpu in gpus:
            gpu.status = GPUStatus.ALLOCATED
            gpu.allocated_to = job_id
            gpu.allocated_at = now
        
        allocation = GPUAllocation(
            job_id=job_id,
            gpus=gpus,
            allocated_at=now,
            user=user,
        )
        
        self.allocations[job_id] = allocation
        
        gpu_ids = [f"{gpu.node_id}:{gpu.gpu_id}" for gpu in gpus]
        logger.info(f"Allocated {len(gpus)} GPUs to job {job_id}: {gpu_ids}")
        
        return True
    
    def release_gpus(self, job_id: str) -> bool:
        """
        Release GPUs allocated to a job.
        
        Args:
            job_id: Job identifier
            
        Returns:
            True if release successful, False if job not found
        """
        if job_id not in self.allocations:
            logger.warning(f"No allocation found for job {job_id}")
            return False
        
        allocation = self.allocations[job_id]
        
        # Release GPUs
        for gpu in allocation.gpus:
            gpu.status = GPUStatus.AVAILABLE
            gpu.allocated_to = None
            gpu.allocated_at = None
            gpu.memory_available_gb = gpu.memory_total_gb  # Reset to full memory
            gpu.utilization_percent = 0.0
        
        del self.allocations[job_id]
        
        logger.info(f"Released {len(allocation.gpus)} GPUs from job {job_id}")
        
        return True
    
    def get_allocation(self, job_id: str) -> Optional[GPUAllocation]:
        """Get GPU allocation for a job"""
        return self.allocations.get(job_id)
    
    def get_total_gpu_count(self) -> int:
        """Get total number of GPUs in cluster"""
        return sum(node.gpu_count for node in self.nodes.values())
    
    def get_available_gpu_count(self) -> int:
        """Get number of currently available GPUs"""
        count = 0
        for node in self.nodes.values():
            for gpu in node.gpus:
                if gpu.status == GPUStatus.AVAILABLE:
                    count += 1
        return count
    
    def get_allocated_gpu_count(self) -> int:
        """Get number of currently allocated GPUs"""
        count = 0
        for node in self.nodes.values():
            for gpu in node.gpus:
                if gpu.status == GPUStatus.ALLOCATED:
                    count += 1
        return count
    
    def get_cluster_status(self) -> dict:
        """
        Get comprehensive cluster status.
        
        Returns:
            Dictionary with cluster state information
        """
        return {
            "total_gpus": self.get_total_gpu_count(),
            "available_gpus": self.get_available_gpu_count(),
            "allocated_gpus": self.get_allocated_gpu_count(),
            "nodes": [node.to_dict() for node in self.nodes.values()],
            "allocations": [alloc.to_dict() for alloc in self.allocations.values()],
            "utilization_percent": round(
                (self.get_allocated_gpu_count() / max(self.get_total_gpu_count(), 1)) * 100, 1
            ),
        }
    
    def update_gpu_metrics(self, node_id: str, gpu_id: int, 
                          utilization: float, memory_used_gb: float,
                          temperature: Optional[float] = None) -> bool:
        """
        Update metrics for a specific GPU.
        
        Args:
            node_id: Node identifier
            gpu_id: GPU identifier
            utilization: GPU utilization percentage (0-100)
            memory_used_gb: Memory used in GB
            temperature: Temperature in Celsius (optional)
            
        Returns:
            True if update successful, False if GPU not found
        """
        if node_id not in self.nodes:
            return False
        
        node = self.nodes[node_id]
        for gpu in node.gpus:
            if gpu.gpu_id == gpu_id:
                gpu.utilization_percent = utilization
                gpu.memory_available_gb = gpu.memory_total_gb - memory_used_gb
                if temperature is not None:
                    gpu.temperature_celsius = temperature
                node.last_updated = time.time()
                return True
        
        return False
    
    def to_dict(self) -> dict:
        """Convert entire state to dictionary for serialization"""
        return {
            "nodes": {node_id: node.to_dict() for node_id, node in self.nodes.items()},
            "allocations": {job_id: alloc.to_dict() for job_id, alloc in self.allocations.items()},
            "cluster_status": self.get_cluster_status(),
        }
    
    def from_dict(self, data: dict) -> None:
        """Load state from dictionary"""
        # TODO: Implement state restoration from persisted data
        logger.info("Loading resource manager state from saved data")
        pass


# Global instance
resource_manager = ResourceManager()
