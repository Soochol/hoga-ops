"""Validated positional condition expressions; never evaluate user text as SQL/code."""
from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field

MAX_EXPRESSION_LENGTH = 10_000
_TOKEN = re.compile(r"\s*(AND\b|OR\b|그리고|또는|[A-Z]+|[()])", re.IGNORECASE)


def condition_label(index: int) -> str:
    label = ""
    index += 1
    while index:
        index, digit = divmod(index - 1, 26)
        label = chr(65 + digit) + label
    return label


@dataclass
class _Parser:
    labels: dict[str, int]
    output: list[int | str] = field(default_factory=list)
    operators: list[str] = field(default_factory=list)
    expect_condition: bool = True

    def consume(self, token: str) -> None:
        if token == "(":
            self._expect_operand()
            self.operators.append(token)
        elif token == ")":
            self._close()
        elif token in {"AND", "OR"}:
            self._join(token)
        else:
            self._expect_operand()
            if token not in self.labels:
                raise ValueError(f"{token}에 해당하는 조건이 없습니다.")
            self.output.append(self.labels[token])
            self.expect_condition = False

    def _expect_operand(self) -> None:
        if not self.expect_condition:
            raise ValueError("조건 사이에 AND 또는 OR를 넣어 주세요.")

    def _close(self) -> None:
        if self.expect_condition:
            raise ValueError("괄호 안에 조건을 입력해 주세요.")
        while self.operators and self.operators[-1] != "(":
            self.output.append(self.operators.pop())
        if not self.operators:
            raise ValueError("여는 괄호가 필요합니다.")
        self.operators.pop()

    def _join(self, token: str) -> None:
        if self.expect_condition:
            raise ValueError("AND 또는 OR 앞에 조건이 필요합니다.")
        precedence = {"AND": 2, "OR": 1}
        while (self.operators and self.operators[-1] != "("
               and precedence[self.operators[-1]] >= precedence[token]):
            self.output.append(self.operators.pop())
        self.operators.append(token)
        self.expect_condition = True

    def finish(self) -> list[int | str]:
        if self.expect_condition:
            raise ValueError("AND 또는 OR 뒤에 조건이 필요합니다.")
        while self.operators:
            token = self.operators.pop()
            if token == "(":
                raise ValueError("닫는 괄호가 필요합니다.")
            self.output.append(token)
        return self.output


def parse_expression(expression: str | None, count: int) -> list[int | str]:
    """Shunting yard → postfix. AND precedes OR; parentheses can nest freely."""
    if expression is None:
        return [token for i in range(count) for token in ([i] if i == 0 else [i, "AND"])]
    if len(expression) > MAX_EXPRESSION_LENGTH:
        raise ValueError("조합식은 10,000자 이내로 입력해 주세요.")
    text = expression.strip()
    if not text:
        if count == 0:
            return []
        raise ValueError("조건 조합식을 입력해 주세요.")
    parser = _Parser({condition_label(i): i for i in range(count)})
    position = 0
    while position < len(text):
        match = _TOKEN.match(text, position)
        if match is None:
            raise ValueError("조합식에는 조건 문자, AND, OR, 괄호만 사용할 수 있습니다.")
        parser.consume({"그리고": "AND", "또는": "OR"}.get(match[1], match[1].upper()))
        position = match.end()
    return parser.finish()


def referenced_indices(expression: str | None, count: int) -> list[int]:
    return sorted({token for token in parse_expression(expression, count) if isinstance(token, int)})


def active_conditions(conditions: Sequence, expression: str | None):
    return [conditions[i] for i in referenced_indices(expression, len(conditions))]


def expression_sql(tokens: list[int | str]) -> str:
    stack: list[str] = []
    for token in tokens:
        if isinstance(token, int):
            stack.append(f"EXISTS (SELECT 1 FROM cond_{token} WHERE cond_{token}.code = base.code)")
        else:
            right, left = stack.pop(), stack.pop()
            stack.append(f"({left} {token} {right})")
    return stack[0] if stack else "TRUE"
