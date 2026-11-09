import { useRef, type ReactNode, type RefObject } from "react";
import { StatusTrayList } from "@fungi.computer/caps/blocks/status-tray";
import { useListMotion } from "@fungi.computer/caps/lib/reorder-motion";

export function AnimatedInventoryList({
  label,
  order,
  children,
  listRoot,
}: {
  label: string;
  order: readonly string[];
  children: ReactNode;
  listRoot?: RefObject<HTMLDivElement>;
}) {
  const localRoot = useRef<HTMLDivElement>(null);
  const root = listRoot ?? localRoot;
  useListMotion(root, order);
  return (
    <div ref={root}>
      <StatusTrayList role="list" aria-label={label}>
        {children}
      </StatusTrayList>
    </div>
  );
}
