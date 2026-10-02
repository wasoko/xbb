import React, { useState, useEffect } from 'react';
import * as li from 'lucide-react'
import { useSearchParams } from 'react-router-dom';
import { Drag } from './drag';
import { iqWithCrumbs, fmtCrumbs } from '../sdb';
import { useAvailableFilters } from './filterStore';

interface FilterBarProps {
  tidLoc?: string | null;
}

export function FilterBar({
  tidLoc
}: FilterBarProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const availableFilters = useAvailableFilters();
  const activeFilters = searchParams.get('f')?.split(',') || [];

  const [crumbsSequence, setCrumbsSequence] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const updateParams = (nextFilters: string[]) => {
    setSearchParams((prev) => {
      if (nextFilters.length === 0) {
        prev.delete('f');
      } else {
        prev.set('f', nextFilters.join(','));
      }
      return prev;
    });
  };

  const updateFilter = (index: number, newValue: string) => {
    const next = [...activeFilters];
    next[index] = newValue;
    updateParams(next);
  };

  const removeFilter = (index: number) => {
    updateParams(activeFilters.filter((_, i) => i !== index));
  };

  const addFilter = (val: string) => {
    updateParams([...activeFilters, val]);
  };

  useEffect(() => {
    async function fetchCrumbs() {
      setIsLoading(true);
      try {
        const { crumbsSequence: newCrumbs } = await iqWithCrumbs(
          activeFilters,
          undefined,
          tidLoc ? Number(tidLoc) : undefined,
          555
        );
        
        // Only update if the sequence has actually changed to avoid infinite loops
        if (JSON.stringify(newCrumbs) !== JSON.stringify(crumbsSequence)) {
          setCrumbsSequence(newCrumbs);
        }
      } catch (e) {
        console.error("Failed to fetch filter crumbs", e);
      } finally {
        setIsLoading(false);
      }
    }
    fetchCrumbs();
  }, [activeFilters.join(','), tidLoc]);

  return (
    <div className={`filter-bar ${isLoading ? 'loading' : ''}`} 
          style={{zIndex:2,position:'fixed', display:'flex', bottom:'77px', left:0, right:0, alignItems: 'end'}}
          >
      {activeFilters.map((filter, i) => {
        const levelOptions = crumbsSequence[i]?.availableCrumb || [];
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Drag 
              current={filter} 
              options={fmtCrumbs(levelOptions)} 
              onSelect={(val) => updateFilter(i, val)}
            />
            <button 
              onClick={() => removeFilter(i)}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 4px' }}
            >
              ×
            </button>
          </div>
        );
      })}
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <span style={{ fontSize: '12px', color: '#888' }}>+</span>
        <Drag 
          current="+" 
          options={fmtCrumbs(crumbsSequence[crumbsSequence.length - 1]?.availableCrumb || [])} 
          onSelect={(val) => {
            if (val) addFilter(val);
          }}
        >
          <li.Plus size={18} />
        </Drag>
      </div>
    </div>
  );
}

async function iqWithCrumbsWrapper(filters: string[], search?: string, tidNum?: number, limit?: number) {
  const { crumbsSequence } = await iqWithCrumbs(filters, search, tidNum, limit);
  return { crumbsSequence };
}

