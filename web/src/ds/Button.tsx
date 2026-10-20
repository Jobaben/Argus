import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "./Icon";
import {
  BASE,
  ICON_SIZE,
  SQUARE,
  VARIANT,
  buttonClass,
  type ButtonSize,
  type ButtonVariant,
} from "./controls";

/** Buttons, links that look like buttons, and icon-only buttons. The class
 *  strings and the ranking of variants are documented in `controls.ts`. */
type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. */
  icon?: IconName;
  /** Trailing icon — a chevron for a disclosure, an arrow for "go there". */
  iconRight?: IconName;
  children?: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  children,
  className = "",
  type = "button",
  ref,
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={ICON_SIZE[size]} />}
      {children}
      {iconRight && <Icon name={iconRight} size={ICON_SIZE[size]} />}
    </button>
  );
}

/** A link that reads as a button: navigation styled as an action. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  children,
  className = "",
  ...rest
}: Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={ICON_SIZE[size]} />}
      {children}
      {iconRight && <Icon name={iconRight} size={ICON_SIZE[size]} />}
    </a>
  );
}

/**
 * A square button with only an icon. `label` is required: it is the accessible
 * name and the tooltip, because an icon alone is a guess.
 */
export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  className = "",
  type = "button",
  ref,
  ...rest
}: {
  icon: IconName;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`${BASE} ${VARIANT[variant]} ${SQUARE[size]} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={ICON_SIZE[size]} />
    </button>
  );
}
