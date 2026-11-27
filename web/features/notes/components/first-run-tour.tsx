import Sherpa, {
  ACTIONS,
  type CallBackProps,
  STATUS,
  type Step,
  type TooltipRenderProps,
} from "@bl4ckh4nd/react-sherpa";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";

const newNoteTarget = "[data-new-note]";
const menuTarget = '[aria-label="Open menu"]';
const storagePrefix = "bordo:notes-tour:v1:";
const seenThisSession = new Set<string>();

function visibleTarget(selector: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
    (element) => element.getClientRects().length > 0,
  );
}

function TourTooltip({
  tooltipProps,
  step,
  index,
  size,
  isLastStep,
  backProps,
  skipProps,
  primaryProps,
}: TooltipRenderProps) {
  const titleId = useId();
  const contentId = useId();

  return (
    <div
      {...tooltipProps}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={contentId}
      className="grid w-80 max-w-[calc(100vw-2rem)] gap-4 rounded-xl border border-border bg-popover p-4 text-foreground shadow-menu"
    >
      <div className="grid gap-1">
        <p className="m-0 text-meta text-muted-foreground">
          Step {index + 1} of {size}
        </p>
        <h2 id={titleId} className="m-0 font-semibold text-lead">
          {step.title}
        </h2>
        <p id={contentId} className="m-0 text-ui text-muted-foreground">
          {step.content}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!isLastStep && (
          <Button {...skipProps} type="button" variant="quiet">
            Skip tour
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          {index > 0 && (
            <Button {...backProps} type="button" variant="secondary">
              Back
            </Button>
          )}
          <Button {...primaryProps} type="button">
            {isLastStep ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FirstRunTour({ userId }: { userId: string }) {
  const key = storagePrefix + userId;
  const [visible, setVisible] = useState(false);
  const [steps, setSteps] = useState<Step[] | null>(null);

  useEffect(() => {
    try {
      setVisible(
        !seenThisSession.has(key) && localStorage.getItem(key) !== "seen",
      );
    } catch {
      setVisible(!seenThisSession.has(key));
    }
  }, [key]);

  const dismiss = useCallback(() => {
    seenThisSession.add(key);
    try {
      localStorage.setItem(key, "seen");
    } catch {
      // The invitation stays dismissed for this session if storage is unavailable.
    }
    setSteps(null);
    setVisible(false);
    requestAnimationFrame(() => {
      (visibleTarget(newNoteTarget) ?? visibleTarget(menuTarget))?.focus({
        preventScroll: true,
      });
    });
  }, [key]);

  const running = steps !== null;
  useEffect(() => {
    if (!running) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }

    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [dismiss, running]);

  function start() {
    const newNote = visibleTarget(newNoteTarget);
    const menu = visibleTarget(menuTarget);
    const newTag = visibleTarget('[aria-label="New tag"]');

    setSteps([
      {
        target: newNote ?? menu ?? "body",
        placement:
          newNote?.dataset.newNote === "sidebar"
            ? "right-start"
            : newNote
              ? "top"
              : menu
                ? "bottom-start"
                : "center",
        title: "Create a note",
        content: newNote
          ? "Select New note to start writing. You can add a title, text, or an attachment."
          : "Open the menu and select New note to start writing.",
        disableBeacon: true,
      },
      {
        target: newTag ?? menu ?? "body",
        placement: newTag ? "right-start" : menu ? "bottom-start" : "center",
        title: "Organize with tags",
        content: newTag
          ? "Create a tag in the sidebar. Add it to a note to find related notes together."
          : menu
            ? "Use the menu to find Tags and group related notes."
            : "Add tags to keep related notes together.",
        disableBeacon: true,
      },
    ]);
  }

  function onTourChange({ action, status }: CallBackProps) {
    if (
      action === ACTIONS.CLOSE ||
      status === STATUS.FINISHED ||
      status === STATUS.SKIPPED
    ) {
      dismiss();
    }
  }

  if (!visible) return null;

  return (
    <section
      aria-label="Getting started"
      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4"
    >
      <div className="grid gap-1">
        <h2 className="m-0 font-semibold text-lead">Get started with Bordo</h2>
        <p className="m-0 text-ui text-muted-foreground">
          Learn how to create a note and organize it with tags.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="quiet" onClick={dismiss}>
          Skip for now
        </Button>
        <Button type="button" onClick={start}>
          Start tour
        </Button>
      </div>
      {steps && (
        <Sherpa
          run
          continuous
          showSkipButton
          disableCloseOnEsc
          disableOverlayClose
          disableScrolling
          steps={steps}
          callback={onTourChange}
          tooltipComponent={TourTooltip}
          locale={{ last: "Done", skip: "Skip tour" }}
          styles={{
            options: {
              arrowColor: "var(--popover)",
              overlayColor: "var(--overlay)",
              zIndex: 90,
            },
          }}
        />
      )}
    </section>
  );
}
