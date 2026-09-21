import { cn } from "@/lib/utils"

interface KCurrencySymbolProps {
    className?: string
    label?: string
}

/** A compact K monogram with twin crossbars, used as the store's currency mark. */
export function KCurrencySymbol({ className, label = "K currency" }: KCurrencySymbolProps) {
    return (
        <svg
            viewBox="0 0 24 24"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            role="img"
            aria-label={label}
            focusable="false"
            className={cn("inline-block shrink-0 overflow-visible", className)}
        >
            <path d="M7 3.25v17.5M18 4.25 7.25 13 18 20" strokeWidth="2.15" />
            <path d="M4 9.25h10.25M4 12.25h8.4" strokeWidth="1.65" />
        </svg>
    )
}
