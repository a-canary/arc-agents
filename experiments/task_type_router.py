#!/usr/bin/env python3
"""
Task-Type Router for Three-Prompt Architecture

Routes queries to either three-prompt (for hard reasoning) or direct prompting
(for saturated/simple tasks) based on heuristics.

Based on validation findings:
- Three-prompt: BBH +10pp (p=0.018) on hard reasoning
- Direct: GSM8K equivalent (p=0.695) on saturated tasks
- Decision is cost-based: use three-prompt when improvement expected
"""

import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class PromptStrategy(Enum):
    """Routing decision."""
    THREE_PROMPT = "three_prompt"  # Use iterative exploration
    DIRECT = "direct"  # Use single-prompt baseline


@dataclass
class RoutingDecision:
    """Router output with explanation."""
    strategy: PromptStrategy
    confidence: float  # 0.0-1.0, how confident in this decision
    reason: str  # Human-readable explanation
    signals: dict  # Debug info about what triggered decision


class TaskTypeRouter:
    """
    Routes queries to appropriate prompting strategy.

    Uses heuristics based on:
    1. Known baseline accuracy (if available)
    2. Problem complexity indicators
    3. Reasoning keywords
    4. Problem length
    """

    # Keywords indicating hard reasoning (favor three-prompt)
    REASONING_KEYWORDS = {
        'deduce', 'infer', 'conclude', 'logical', 'reasoning',
        'constraint', 'satisfy', 'consistent', 'contradiction',
        'if-then', 'therefore', 'because', 'given that',
        'prove', 'disprove', 'must be', 'cannot be',
        'arrangement', 'order', 'sequence', 'position',
        'before', 'after', 'between', 'relative to'
    }

    # Keywords indicating simple/recall (favor direct)
    SIMPLE_KEYWORDS = {
        'what is', 'who is', 'when was', 'where is',
        'define', 'meaning', 'definition',
        'calculate', 'compute', 'add', 'subtract', 'multiply', 'divide',
        'how many', 'how much', 'total', 'sum'
    }

    # Thresholds
    HIGH_BASELINE_THRESHOLD = 0.90  # If known baseline ≥90%, use direct
    LONG_PROBLEM_THRESHOLD = 200  # Characters - long problems may need exploration
    MIN_REASONING_SIGNALS = 2  # Minimum reasoning keywords to trigger three-prompt

    def route(
        self,
        query: str,
        baseline_accuracy: Optional[float] = None,
        context: Optional[dict] = None
    ) -> RoutingDecision:
        """
        Route query to appropriate strategy.

        Args:
            query: The problem/question to route
            baseline_accuracy: Known baseline accuracy for this problem type (0.0-1.0)
            context: Additional metadata (task_type, domain, etc.)

        Returns:
            RoutingDecision with strategy, confidence, and reasoning
        """
        signals = {}
        reasons = []

        # Signal 1: Known baseline accuracy (highest priority)
        if baseline_accuracy is not None:
            signals['baseline_accuracy'] = baseline_accuracy
            if baseline_accuracy >= self.HIGH_BASELINE_THRESHOLD:
                return RoutingDecision(
                    strategy=PromptStrategy.DIRECT,
                    confidence=0.9,
                    reason=f"High baseline ({baseline_accuracy:.1%}) - saturated task, use direct (cost savings)",
                    signals=signals
                )
            else:
                reasons.append(f"Moderate baseline ({baseline_accuracy:.1%}) - room for improvement")

        # Signal 2: Reasoning keyword analysis
        query_lower = query.lower()
        reasoning_count = sum(1 for kw in self.REASONING_KEYWORDS if kw in query_lower)
        simple_count = sum(1 for kw in self.SIMPLE_KEYWORDS if kw in query_lower)

        signals['reasoning_keywords'] = reasoning_count
        signals['simple_keywords'] = simple_count
        signals['query_length'] = len(query)

        # Signal 3: Problem length (longer = more complex)
        is_long = len(query) >= self.LONG_PROBLEM_THRESHOLD
        signals['is_long_problem'] = is_long

        # Decision logic
        score = 0  # Positive = three-prompt, Negative = direct

        # Reasoning keywords strongly suggest three-prompt
        if reasoning_count >= self.MIN_REASONING_SIGNALS:
            score += 3
            reasons.append(f"Multiple reasoning keywords ({reasoning_count})")
        elif reasoning_count > 0:
            score += 1
            reasons.append(f"Contains reasoning keyword")

        # Simple keywords suggest direct
        if simple_count >= 2:
            score -= 2
            reasons.append(f"Multiple simple/recall keywords ({simple_count})")
        elif simple_count > 0:
            score -= 1
            reasons.append(f"Contains simple keyword")

        # Long problems often need exploration
        if is_long:
            score += 1
            reasons.append(f"Long problem ({len(query)} chars) may need exploration")

        # Check for multiple choice format (often recall/factual)
        if self._is_multiple_choice(query):
            # Multiple choice could be either reasoning (BBH) or recall (MMLU)
            # Don't penalize, but note it
            signals['is_multiple_choice'] = True
            reasons.append("Multiple choice format detected")

        # Make decision
        if score > 0:
            strategy = PromptStrategy.THREE_PROMPT
            confidence = min(0.5 + (score * 0.1), 0.9)
            reason_prefix = "Use three-prompt:"
        else:
            strategy = PromptStrategy.DIRECT
            confidence = min(0.5 + (abs(score) * 0.1), 0.9)
            reason_prefix = "Use direct:"

        # If no strong signals, default to direct (conservative)
        if not reasons:
            strategy = PromptStrategy.DIRECT
            confidence = 0.5
            reasons.append("No strong signals - default to direct (cost savings)")

        reason = f"{reason_prefix} {'; '.join(reasons)}"

        return RoutingDecision(
            strategy=strategy,
            confidence=confidence,
            reason=reason,
            signals=signals
        )

    def _is_multiple_choice(self, query: str) -> bool:
        """Check if query is multiple choice format."""
        # Look for patterns like "(A)", "(B)", or "A)", "B)"
        mc_pattern = r'\([A-E]\)|[A-E]\)'
        matches = re.findall(mc_pattern, query)
        return len(matches) >= 2  # At least 2 options


def main():
    """Demo the router with example queries."""
    router = TaskTypeRouter()

    examples = [
        # Hard reasoning (should route to three-prompt)
        {
            "query": """The following paragraphs describe a set of three objects arranged in order.
The statements are logically consistent. On a shelf, there are three books: a blue book,
a red book, and a green book. The red book is to the right of the blue book.
The blue book is to the right of the green book.
Options: (A) The blue book is second (B) The green book is second (C) The red book is second""",
            "baseline": 0.84,
            "expected": PromptStrategy.THREE_PROMPT,
            "label": "BBH logical deduction"
        },
        # Simple math (high baseline, should route to direct)
        {
            "query": "Janet has 3 apples. She gives 1 apple to her friend. How many apples does Janet have now?",
            "baseline": 0.94,
            "expected": PromptStrategy.DIRECT,
            "label": "GSM8K simple math"
        },
        # Recall question (should route to direct)
        {
            "query": "What is the capital of France? Options: (A) London (B) Paris (C) Berlin (D) Madrid",
            "baseline": None,
            "expected": PromptStrategy.DIRECT,
            "label": "Simple recall"
        },
        # Complex word problem (no baseline)
        {
            "query": """A train leaves Station A at 10 AM traveling at 60 mph. Another train leaves
Station B at 11 AM traveling at 80 mph toward Station A. If the stations are 200 miles apart,
when will they meet? Show your reasoning.""",
            "baseline": None,
            "expected": PromptStrategy.THREE_PROMPT,
            "label": "Complex word problem"
        },
        # Factual with high baseline
        {
            "query": "In which year did World War II end?",
            "baseline": 0.95,
            "expected": PromptStrategy.DIRECT,
            "label": "Factual (saturated)"
        }
    ]

    print("="*80)
    print("TASK-TYPE ROUTER DEMONSTRATION")
    print("="*80)
    print()

    correct = 0
    for i, example in enumerate(examples, 1):
        print(f"Example {i}: {example['label']}")
        print(f"Query: {example['query'][:100]}...")
        if example['baseline']:
            print(f"Baseline: {example['baseline']:.1%}")

        decision = router.route(
            query=example['query'],
            baseline_accuracy=example['baseline']
        )

        is_correct = decision.strategy == example['expected']
        correct += is_correct

        status = "✓" if is_correct else "✗"
        print(f"\n{status} Decision: {decision.strategy.value}")
        print(f"  Confidence: {decision.confidence:.1%}")
        print(f"  Reason: {decision.reason}")
        print(f"  Signals: {decision.signals}")
        print(f"  Expected: {example['expected'].value}")
        print()
        print("-"*80)
        print()

    accuracy = 100 * correct / len(examples)
    print(f"Router Accuracy: {correct}/{len(examples)} = {accuracy:.0f}%")
    print("="*80)


if __name__ == "__main__":
    main()
