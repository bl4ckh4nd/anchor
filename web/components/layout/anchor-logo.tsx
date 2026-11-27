import { cn } from "@/lib/utils";

export function AnchorLogo({ className }: { className?: string }) {
  return (
    <img
      src="/icon0.svg"
      alt=""
      width={64}
      height={64}
      className={cn("flex-none", className)}
    />
  );
}
