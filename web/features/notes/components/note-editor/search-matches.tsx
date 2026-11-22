"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import * as React from "react";
import { IconButton } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useRovingFocus } from "@/lib/hooks/use-roving-focus";
import { prefersReducedMotion } from "@/lib/motion";
import { findMatches } from "../../find-matches";

// Painted by ::highlight() in note-editor.css. Ranges, not elements: Quill's
// text, its undo and the saved note stay as they are.
const MATCH = "search-match";
const CURRENT = "search-current";

const isSupported = () =>
  typeof CSS !== "undefined" &&
  "highlights" in CSS &&
  typeof Highlight !== "undefined";

/** The title, then each of Quill's lines: a match never spans two of them. */
function linesOf(root: HTMLElement) {
  const lines = [...root.querySelectorAll<HTMLElement>("[data-find]")];
  const editor = root.querySelector(".ql-editor");
  for (const block of editor?.children ?? [])
    if (block.matches("ol, ul, .ql-code-block-container"))
      lines.push(
        ...block.querySelectorAll<HTMLElement>(":scope > :not(.ql-ui)"),
      );
    else lines.push(block as HTMLElement);
  return lines;
}

function findRanges(root: HTMLElement, query: string) {
  const ranges: Range[] = [];
  let nodes: { node: Text; start: number }[] = [];
  let text = "";
  // Marks the text gathered so far; an embed or a line ends it.
  const flush = () => {
    const at = (offset: number, isEnd: boolean) => {
      let i = nodes.length - 1;
      while (
        i > 0 &&
        (isEnd ? nodes[i].start >= offset : nodes[i].start > offset)
      )
        i--;
      return [nodes[i].node, offset - nodes[i].start] as const;
    };
    for (const [start, end] of findMatches(text, query)) {
      const range = document.createRange();
      range.setStart(...at(start, false));
      range.setEnd(...at(end, true));
      ranges.push(range);
    }
    nodes = [];
    text = "";
  };
  for (const line of linesOf(root)) {
    // Folded checked items aren't on screen: nothing to show or step to.
    if (!line.getBoundingClientRect().height) continue;
    const walker = document.createTreeWalker(
      line,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
          const el = node as Element;
          // Pictures and Quill's own controls aren't text: a match stops at
          // them. A read-only editor is all contenteditable="false", so only
          // ones inside the line count.
          if (
            el.matches(
              'img, video, iframe, br, .ql-ui, [contenteditable="false"]',
            )
          ) {
            flush();
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      },
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node: node as Text, start: text.length });
      text += (node as Text).data;
    }
    flush();
  }
  return ranges;
}

function scrollToRange(range: Range, root: HTMLElement) {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const scroller = root.closest<HTMLElement>(".ed-scroll");
  const view = scroller?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
  };
  // Clear of the sticky header, toolbar and bar.
  const bar = root.querySelector(".find-bar")?.getBoundingClientRect();
  const top = Math.max(view.top, bar?.bottom ?? 0) + 16;
  if (rect.top >= top && rect.bottom <= view.bottom - 40) return;
  const by = rect.top - (top + view.bottom) / 2;
  const behavior = prefersReducedMotion() ? "instant" : "smooth";
  (scroller ?? window).scrollBy({ top: by, behavior });
}

/**
 * Marks where `query` is in the title and text of the note in `root`, until
 * the person types or stops it. Nothing where the browser can't paint it.
 */
export function useSearchMatches(
  root: React.RefObject<HTMLElement | null>,
  query: string,
) {
  const [stoppedFor, setStoppedFor] = React.useState<string | null>(null);
  // A new search starts afresh, even one for the term stopped before.
  const [lastQuery, setLastQuery] = React.useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setStoppedFor(null);
  }
  // Kept with the search they were found for, so a new search starts empty.
  const [found, setFound] = React.useState<{ query: string; ranges: Range[] }>({
    query: "",
    ranges: [],
  });
  const ranges = found.query === query ? found.ranges : [];
  const [current, setCurrent] = React.useState(0);
  const scrolledFor = React.useRef<string | null>(null);
  const isOn = query.trim() !== "" && stoppedFor !== query && isSupported();

  React.useEffect(() => {
    const el = root.current;
    setCurrent(0);
    if (!isOn || !el) {
      setFound({ query: "", ranges: [] });
      return;
    }
    let frame = 0;
    const scan = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setFound({ query, ranges: findRanges(el, query) }),
      );
    };
    scan();
    // The text arrives after the page, and can change from elsewhere.
    // Folding checked items rewrites a style sheet in the editor.
    const watched = ".ql-editor, [data-find], style";
    const observer = new MutationObserver((records) => {
      if (
        records.some((record) =>
          (record.target instanceof Element
            ? record.target
            : record.target.parentElement
          )?.closest(watched),
        )
      )
        scan();
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [root, query, isOn]);

  const index = Math.min(current, ranges.length - 1);
  React.useEffect(() => {
    if (index < 0) return;
    CSS.highlights.set(
      MATCH,
      new Highlight(...ranges.filter((_, i) => i !== index)),
    );
    CSS.highlights.set(CURRENT, new Highlight(ranges[index]));
    return () => {
      CSS.highlights.delete(MATCH);
      CSS.highlights.delete(CURRENT);
    };
  }, [ranges, index]);

  React.useEffect(() => {
    const el = root.current;
    if (!el || index < 0 || scrolledFor.current === query) return;
    scrolledFor.current = query;
    scrollToRange(ranges[index], el);
  }, [root, ranges, index, query]);

  const go = (step: 1 | -1) => {
    const el = root.current;
    if (!el || !ranges.length) return;
    const next = (index + step + ranges.length) % ranges.length;
    setCurrent(next);
    scrollToRange(ranges[next], el);
  };

  return {
    query: query.trim(),
    count: ranges.length,
    index,
    next: () => go(1),
    previous: () => go(-1),
    /** On Esc or ×, and on any edit to the title or text. */
    stop: () => setStoppedFor(query),
    /** Looking for matches: the title's text box gets a copy to mark. */
    isOn,
    hasMatches: ranges.length > 0,
  };
}

export type SearchMatches = ReturnType<typeof useSearchMatches>;

export function SearchMatchesBar({
  matches,
  onEscape,
}: {
  matches: SearchMatches;
  /** Closed from the keyboard: focus goes back to the text. */
  onEscape: () => void;
}) {
  const roving = useRovingFocus<HTMLDivElement>();
  if (!matches.hasMatches) return null;
  const button = (
    label: string,
    icon: React.ReactNode,
    onClick: (e: React.MouseEvent) => void,
  ) => (
    <Tip label={label}>
      <IconButton size="sm" label={label} onClick={onClick}>
        {icon}
      </IconButton>
    </Tip>
  );
  return (
    <div
      ref={roving.ref}
      className="find-bar"
      role="toolbar"
      aria-label="Search matches"
      onFocus={roving.onFocus}
      onKeyDown={(e) => {
        roving.onKeyDown(e);
        if (e.key === "Escape") {
          e.preventDefault();
          matches.stop();
          onEscape();
        }
      }}
    >
      <span className="find-term">“{matches.query}”</span>
      <span className="find-count" role="status">
        {matches.index + 1} of {matches.count}
      </span>
      {button("Previous match", <ArrowUp aria-hidden />, matches.previous)}
      {button("Next match", <ArrowDown aria-hidden />, matches.next)}
      {button("Stop highlighting", <X aria-hidden />, (e) => {
        matches.stop();
        // From the keyboard; a tap must not raise a phone's keyboard.
        if (e.detail === 0) onEscape();
      })}
    </div>
  );
}
