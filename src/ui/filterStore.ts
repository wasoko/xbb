import { useState, useEffect } from 'react';

type Listener = (filters: string[]) => void;

class FilterStore {
  private filters: string[] = [];
  private listeners: Set<Listener> = new Set();

  setAvailable(filters: string[]) {
    this.filters = filters;
    this.listeners.forEach(l => l(this.filters));
  }

  getAvailable() {
    return this.filters;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const filterStore = new FilterStore();

export function useAvailableFilters() {
  const [filters, setFilters] = useState(filterStore.getAvailable());

  useEffect(() => {
    return filterStore.subscribe(setFilters);
  }, []);

  return filters;
}
