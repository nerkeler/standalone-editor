---
title: "Markdown fidelity fixture"
tags: [writing, obsidian]
date: 2026-09-24
---

# Markdown fidelity fixture

Front matter sits above this heading. Wiki links: [[Existing Note]] and [[Folder/Target|friendly label]]. An embed looks like ![[diagram.png]].

Escaping: \*literal emphasis\*, `inline code`, an ampersand & and a backslash \\.

## Nested tasks

- [ ] Parent task
  - [x] Nested completed task
  - [ ] Nested open task
- [x] Second parent task
  1. [ ] Nested ordered task
	- [x] Tab-indented task

## Table with rich cells

| Name | Details | Notes |
| --- | --- | --- |
| Alpha | **bold** and `code` | a \| b |
| Beta | first line<br>second line | [reference link][source] |

[source]: https://example.com/docs "Reference title"

## Raw HTML

<details>
<summary>Disclosure summary</summary>

Raw **HTML** body.
</details>

<div class="callout" data-kind="note">HTML attribute marker</div>

## Relative image and code fence

![Architecture diagram](./images/diagram.png "diagram title")

```ts title="sample.ts"
const marker = "preserve this code";
console.log(marker);
```
