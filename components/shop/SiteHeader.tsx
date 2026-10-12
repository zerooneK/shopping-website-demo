import Link from "next/link";
import { SearchForm } from "./SearchForm";

export function SiteHeader() {
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-8">
        <Link
          href="/"
          className="tap display inline-flex items-center text-2xl text-ink"
          aria-label="Second Room — กลับหน้าแรก"
        >
          Second Room
        </Link>
        <SearchForm id="header-search" className="w-full sm:w-72" />
      </div>
    </header>
  );
}
