type Tone = "neutral" | "stone" | "success";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-gray-100 text-gray-600",
  stone: "bg-white text-carysil-stone ring-1 ring-gray-200",
  success: "bg-carysil-success/10 text-carysil-success",
};

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center break-words rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
