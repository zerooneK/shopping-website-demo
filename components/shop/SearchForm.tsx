type Props = { id: string; defaultValue?: string; className?: string };

/** ค้นหารหัสสินค้า — GET /search?q=… (route handler normalize แล้ว redirect จริง) */
export function SearchForm({ id, defaultValue, className }: Props) {
  return (
    <form action="/search" method="get" role="search" className={className}>
      <label htmlFor={id} className="sr-only">
        ค้นหาด้วยรหัสสินค้า
      </label>
      <div className="flex items-stretch border border-rule focus-within:border-ink">
        <input
          id={id}
          name="q"
          type="search"
          inputMode="text"
          autoComplete="off"
          defaultValue={defaultValue}
          placeholder="ค้นรหัส เช่น 012"
          className="tap w-full min-w-0 bg-transparent px-3 text-base text-ink placeholder:text-muted focus:outline-none"
        />
        <button
          type="submit"
          className="tap meta meta-th shrink-0 border-l border-rule px-3 text-ink hover:bg-ink hover:text-paper"
        >
          ค้นหา
        </button>
      </div>
    </form>
  );
}
