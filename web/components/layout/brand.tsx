import { Link } from "@/lib/app-router";
import { cn } from "@/lib/utils";
import { AnchorLogo } from "./anchor-logo";

export function Brand({
  href,
  className,
  compact,
  onNavigate,
}: {
  href?: string;
  className?: string;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const content = compact ? (
    <>
      <AnchorLogo className="size-7" />
      <span className="sr-only">Bordo</span>
    </>
  ) : (
    <>
      <img
        src="/icons/bordo-wordmark.svg"
        alt="Bordo"
        width={211}
        height={64}
        className="h-7 w-auto flex-none dark:hidden"
      />
      <img
        src="/icons/bordo-wordmark-dark.svg"
        alt="Bordo"
        width={211}
        height={64}
        className="hidden h-7 w-auto flex-none dark:block"
      />
    </>
  );
  const classes = cn(
    "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-inherit no-underline",
    className,
  );
  return href ? (
    <Link href={href} className={classes} onClick={onNavigate}>
      {content}
    </Link>
  ) : (
    <span className={classes}>{content}</span>
  );
}
