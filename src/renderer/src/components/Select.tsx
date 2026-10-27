import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Extra classes for the trigger (e.g. `select-sm`). */
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
  /** Shown when the current value matches no option. */
  placeholder?: string;
}

const MENU_MAX_HEIGHT = 288;
const ROW_HEIGHT = 32;

/**
 * A themed replacement for `<select>`.
 *
 * The native select popup is painted by Chromium outside the DOM, so
 * `option:checked` CSS is ignored and the current row keeps the system blue
 * highlight. This component renders its own menu (in a portal, so it escapes
 * modal overflow) and highlights the selected row with the theme accent.
 */
export default function Select({
  value,
  options,
  onChange,
  className,
  style,
  disabled,
  title,
  placeholder,
}: SelectProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, maxHeight: MENU_MAX_HEIGHT });
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const contentHeight = options.length * ROW_HEIGHT + 10;
    const need = Math.min(MENU_MAX_HEIGHT, contentHeight);
    const spaceBelow = window.innerHeight - r.bottom - 12;
    const spaceAbove = r.top - 12;
    const openUp = spaceBelow < need && spaceAbove > spaceBelow;
    const available = openUp ? spaceAbove : spaceBelow;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)),
      top: openUp ? r.top - Math.min(need, available) - 4 : r.bottom + 4,
      width: r.width,
      // Never taller than the cap, but shrink to whatever space is left.
      maxHeight: Math.max(96, Math.min(MENU_MAX_HEIGHT, Math.min(need, available))),
    });
  }, [options.length]);

  /**
   * Keep the menu glued to its trigger instead of closing.
   * Closing on any scroll made the list impossible to use: the wheel and the
   * scrollbar both scroll the menu (a descendant of window), and `scrollIntoView`
   * scrolled the surrounding modal, dismissing the menu the user was aiming at.
   * Only give up when the trigger itself has scrolled out of view.
   */
  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      setOpen(false);
      return;
    }
    place();
  }, [place]);

  const openMenu = useCallback(() => {
    place();
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [place, selectedIndex]);

  const close = useCallback(() => setOpen(false), []);

  const commit = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [options, onChange],
  );

  // Dismiss on outside pointer-down / Escape. Scroll & resize only reposition.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    };
    /**
     * Scroll handler. `capture: true` sees scrolls from EVERY element, so we must
     * ignore anything inside the menu — otherwise scrolling the option list with
     * the wheel (or dragging its scrollbar) would dismiss the list immediately.
     */
    const onScroll = (e: Event): void => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      reposition();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close, reposition]);

  // Focus the menu so arrow keys work, and keep the active row in view.
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    menu.focus({ preventScroll: true });
    const item = menu.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!item) return;
    // Scroll ONLY the menu. `scrollIntoView` would also scroll the surrounding
    // modal / page, which used to dismiss the menu.
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }, [open, activeIndex]);

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) openMenu();
    }
  }

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Tab':
        close();
        break;
      default:
        break;
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select tselect-trigger${className ? ` ${className}` : ''}`}
        style={style}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="tselect-value">{selected?.label ?? placeholder ?? value}</span>
        <span className="tselect-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="tselect-menu"
            role="listbox"
            tabIndex={-1}
            style={{
              left: pos.left,
              top: pos.top,
              width: pos.width,
              maxHeight: pos.maxHeight,
            }}
            onKeyDown={onMenuKeyDown}
          >
            {options.map((o, i) => {
              const isSelected = i === selectedIndex;
              const isActive = i === activeIndex;
              return (
                <button
                  key={`${o.value}::${i}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-index={i}
                  disabled={o.disabled}
                  className={`tselect-item${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(i)}
                >
                  <span className="tselect-label">{o.label}</span>
                  {isSelected && (
                    <span className="tselect-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
