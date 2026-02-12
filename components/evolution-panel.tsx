"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Dna,
  Play,
  Square,
  RefreshCw,
  Trophy,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import type { EvolutionStatus, EvolutionCandidate } from "@/lib/types";
import {
  getEvolutionStatus,
  getEvolutionCandidates,
  stopEvolution,
} from "@/lib/api";

// ─── Phase badge ───

function PhaseBadge({ phase }: { phase: string }) {
  const colors: Record<string, string> = {
    idle: "bg-gray-500/20 text-gray-400",
    initializing: "bg-blue-500/20 text-blue-400",
    generating: "bg-purple-500/20 text-purple-400",
    evaluating: "bg-amber-500/20 text-amber-400",
    selecting: "bg-green-500/20 text-green-400",
    complete: "bg-emerald-500/20 text-emerald-400",
    failed: "bg-red-500/20 text-red-400",
    paused: "bg-yellow-500/20 text-yellow-400",
  };

  const icons: Record<string, string> = {
    idle: "⏸",
    initializing: "🔧",
    generating: "🧬",
    evaluating: "🔬",
    selecting: "🎯",
    complete: "✅",
    failed: "❌",
    paused: "⏸",
  };

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colors[phase] || colors.idle}`}
    >
      {icons[phase] || "•"} {phase}
    </span>
  );
}

// ─── Score display ───

function ScoreDisplay({ score, label }: { score: number | null; label: string }) {
  return (
    <div className="flex flex-col items-center p-2 rounded-lg bg-white/5">
      <span className="text-[10px] uppercase tracking-wider text-gray-500">
        {label}
      </span>
      <span className="text-lg font-mono font-bold text-emerald-400">
        {score !== null ? score.toFixed(4) : "—"}
      </span>
    </div>
  );
}

// ─── Candidate item ───

function CandidateItem({ candidate }: { candidate: EvolutionCandidate }) {
  const [expanded, setExpanded] = useState(false);

  const statusColor: Record<string, string> = {
    pending: "text-gray-400",
    evaluating: "text-amber-400",
    scored: "text-emerald-400",
    failed: "text-red-400",
  };

  return (
    <div className="border border-white/5 rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/5 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-gray-500" />
        ) : (
          <ChevronRight className="w-3 h-3 text-gray-500" />
        )}
        <span className="font-mono text-gray-300">{candidate.id}</span>
        <span className={`ml-auto ${statusColor[candidate.status] || "text-gray-400"}`}>
          {candidate.status}
        </span>
        {candidate.score !== null && (
          <span className="font-mono text-emerald-400 ml-2">
            {candidate.score.toFixed(4)}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2 bg-black/30 border-t border-white/5">
          <pre className="text-[11px] font-mono text-gray-400 overflow-x-auto max-h-40 whitespace-pre-wrap">
            {candidate.code.slice(0, 500)}
            {candidate.code.length > 500 && "..."}
          </pre>
          {candidate.parent_id && (
            <div className="mt-1 text-[10px] text-gray-500">
              Parent: {candidate.parent_id}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Progress bar ───

function EvolutionProgressBar({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  return (
    <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
      <div
        className="h-full rounded-full bg-gradient-to-r from-purple-500 to-emerald-500 transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─── Main panel ───

interface EvolutionPanelProps {
  /** If true, use compact inline mode */
  compact?: boolean;
}

export function EvolutionPanel({ compact = false }: EvolutionPanelProps) {
  const [status, setStatus] = useState<EvolutionStatus | null>(null);
  const [candidates, setCandidates] = useState<EvolutionCandidate[]>([]);
  const [expanded, setExpanded] = useState(!compact);
  const [stopping, setStopping] = useState(false);

  // Poll for status
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    const poll = async () => {
      try {
        const s = await getEvolutionStatus();
        setStatus(s);

        // Only fetch candidates if actively evolving
        if (s.status !== "idle") {
          const c = await getEvolutionCandidates();
          setCandidates(c);
        }
      } catch {
        // Server may not have evolution endpoints yet — silently ignore
      }
    };

    poll();
    interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleStop = useCallback(async () => {
    setStopping(true);
    try {
      const s = await stopEvolution();
      setStatus(s);
    } catch (err) {
      console.error("Failed to stop evolution:", err);
    } finally {
      setStopping(false);
    }
  }, []);

  // Don't render if no active session
  if (!status || status.status === "idle") return null;

  const isActive = !["idle", "complete", "failed"].includes(status.status);
  const elapsed = Math.round(status.elapsed_seconds);
  const elapsedMin = Math.floor(elapsed / 60);
  const elapsedSec = elapsed % 60;

  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-purple-500/10 border border-purple-500/20 rounded-lg">
        <Dna className="w-4 h-4 text-purple-400 animate-pulse" />
        <span className="text-xs text-gray-300">
          Gen {status.generation}/{status.total_generations}
        </span>
        {status.best_score !== null && (
          <span className="text-xs font-mono text-emerald-400">
            Best: {status.best_score.toFixed(4)}
          </span>
        )}
        <PhaseBadge phase={status.status} />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-purple-500/20 bg-gradient-to-b from-purple-500/5 to-transparent overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-white/5 transition-colors"
      >
        <Dna
          className={`w-5 h-5 text-purple-400 ${isActive ? "animate-pulse" : ""}`}
        />
        <span className="text-sm font-semibold text-gray-200">
          🧬 Evolution
        </span>
        <PhaseBadge phase={status.status} />
        <span className="ml-auto text-xs text-gray-500 font-mono">
          {elapsedMin}:{elapsedSec.toString().padStart(2, "0")}
        </span>
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-500" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Progress */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>
                Generation {status.generation} of {status.total_generations}
              </span>
              <span>
                {status.candidates_evaluated} evaluated
              </span>
            </div>
            <EvolutionProgressBar
              current={status.generation}
              total={status.total_generations}
            />
          </div>

          {/* Score cards */}
          <div className="grid grid-cols-2 gap-2">
            <ScoreDisplay score={status.best_score} label="Best Score" />
            <ScoreDisplay
              score={status.candidates_total > 0 ? status.candidates_evaluated : null}
              label="Candidates"
            />
          </div>

          {/* Goal */}
          {status.config?.goal && (
            <div className="text-xs text-gray-400 bg-white/5 rounded-lg p-2">
              <span className="text-gray-500 uppercase text-[10px] tracking-wider">
                Goal
              </span>
              <p className="mt-0.5">{status.config.goal}</p>
            </div>
          )}

          {/* Candidates */}
          {candidates.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">
                Recent Candidates
              </span>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {candidates.slice(-5).reverse().map((c) => (
                  <CandidateItem key={c.id} candidate={c} />
                ))}
              </div>
            </div>
          )}

          {/* Controls */}
          {isActive && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-colors disabled:opacity-50"
            >
              {stopping ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Square className="w-3 h-3" />
              )}
              Stop Evolution
            </button>
          )}

          {status.status === "complete" && status.best_score !== null && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <Trophy className="w-4 h-4 text-emerald-400" />
              <span className="text-xs text-emerald-400">
                Evolution complete! Best score: {status.best_score.toFixed(4)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
