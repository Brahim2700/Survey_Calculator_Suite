import { useState, useMemo, useEffect, useRef, useId } from 'react';
import CRS_LIST from '../crsList';
import '../styles/CrsSearchSelector.css';

const COUNTRY_PATTERNS = {
  France: ['france', 'corsica', 'metropolitaine'],
  Australia: ['australia'],
  'New Zealand': ['new zealand'],
  Canada: ['canada', 'quebec', 'alberta', 'ontario', 'british columbia'],
  USA: ['united states', 'usa', 'u.s.', 'alaska', 'hawaii', 'puerto rico'],
  UK: ['united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales'],
  Germany: ['germany'],
  Spain: ['spain'],
  Italy: ['italy'],
  Belgium: ['belgium'],
  Netherlands: ['netherlands'],
  Switzerland: ['switzerland'],
  Austria: ['austria'],
  Portugal: ['portugal'],
  Ireland: ['ireland'],
  Poland: ['poland'],
  Czechia: ['czech', 'czechia'],
  Denmark: ['denmark'],
  Sweden: ['sweden'],
  Norway: ['norway'],
  Finland: ['finland'],
  Morocco: ['morocco'],
  Algeria: ['algeria'],
  Tunisia: ['tunisia'],
  Egypt: ['egypt'],
  'South Africa': ['south africa'],
  Kenya: ['kenya'],
  Nigeria: ['nigeria'],
  'Saudi Arabia': ['saudi arabia'],
  UAE: ['united arab emirates', 'uae'],
  Qatar: ['qatar'],
  Oman: ['oman'],
  Japan: ['japan'],
  China: ['china', 'hong kong', 'taiwan', 'macau'],
  India: ['india'],
  Malaysia: ['malaysia'],
  Thailand: ['thailand'],
  Singapore: ['singapore'],
  Indonesia: ['indonesia'],
  Philippines: ['philippines'],
  Brazil: ['brazil'],
  Argentina: ['argentina'],
  Chile: ['chile'],
  Mexico: ['mexico'],
  'New Caledonia': ['new caledonia'],
  Fiji: ['fiji'],
  Global: ['world', 'global'],
};

const COUNTRY_TO_CONTINENT = {
  France: 'Europe',
  UK: 'Europe',
  Germany: 'Europe',
  Spain: 'Europe',
  Italy: 'Europe',
  Belgium: 'Europe',
  Netherlands: 'Europe',
  Switzerland: 'Europe',
  Austria: 'Europe',
  Portugal: 'Europe',
  Ireland: 'Europe',
  Poland: 'Europe',
  Czechia: 'Europe',
  Denmark: 'Europe',
  Sweden: 'Europe',
  Norway: 'Europe',
  Finland: 'Europe',
  USA: 'North America',
  Canada: 'North America',
  Mexico: 'North America',
  Brazil: 'South America',
  Argentina: 'South America',
  Chile: 'South America',
  Morocco: 'Africa',
  Algeria: 'Africa',
  Tunisia: 'Africa',
  Egypt: 'Africa',
  'South Africa': 'Africa',
  Kenya: 'Africa',
  Nigeria: 'Africa',
  'Saudi Arabia': 'Middle East',
  UAE: 'Middle East',
  Qatar: 'Middle East',
  Oman: 'Middle East',
  Japan: 'Asia',
  China: 'Asia',
  India: 'Asia',
  Malaysia: 'Asia',
  Thailand: 'Asia',
  Singapore: 'Asia',
  Indonesia: 'Asia',
  Philippines: 'Asia',
  Australia: 'Oceania',
  'New Zealand': 'Oceania',
  'New Caledonia': 'Oceania',
  Fiji: 'Oceania',
  Global: 'Global',
};

const detectCountries = (crs) => {
  const text = `${crs.label || ''} ${crs.region || ''}`.toLowerCase();
  const found = [];

  Object.entries(COUNTRY_PATTERNS).forEach(([country, patterns]) => {
    if (patterns.some((p) => text.includes(p))) {
      found.push(country);
    }
  });

  return found.length > 0 ? found : ['Other'];
};

// Get all countries for the selected continent with counts
const getAllCountries = (selectedContinent = 'all') => {
  const countryCounts = {};
  
  CRS_LIST.forEach(crs => {
    const countries = detectCountries(crs);
    countries.forEach(country => {
      const continent = COUNTRY_TO_CONTINENT[country] || 'Other';
      if (selectedContinent !== 'all' && continent !== selectedContinent) {
        return;
      }
      if (!countryCounts[country]) {
        countryCounts[country] = 0;
      }
      countryCounts[country]++;
    });
  });
  
  // Convert to sorted array with counts
  return Object.entries(countryCounts)
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count); // Sort by count descending
};

export default function CrsSearchSelector({ value, onChange, label }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all, geographic, projected, utm, tm, conic
  const [continentFilter, setContinentFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all'); // all or specific country
  const [recommendedOnly, setRecommendedOnly] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [favorites, setFavorites] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('crs_favorites') || '[]');
    } catch {
      return [];
    }
  });
  const [recent, setRecent] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('crs_recent') || '[]');
    } catch {
      return [];
    }
  });
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const reactId = useId();
  const listboxId = `crs-listbox-${reactId.replace(/[:]/g, '')}`;
  
  const continents = useMemo(() => {
    const values = new Set(Object.values(COUNTRY_TO_CONTINENT));
    return ['all', ...Array.from(values).sort()];
  }, []);

  // Get all available countries for selected continent
  const allCountries = useMemo(() => getAllCountries(continentFilter), [continentFilter]);

  // Determine category from CRS code/type - improved detection
  const getCrsCategory = (crs) => {
    const code = crs.code.toUpperCase();
    const label = crs.label.toLowerCase();
    const proj4def = crs.proj4def.toLowerCase();
    
    // Check if it's geographic (contains longlat in proj4)
    if (proj4def.includes('+proj=longlat') || crs.type === 'geographic') {
      return 'geographic';
    }
    
    // Check for UTM zones
    if (code.includes('32') || label.includes('utm')) {
      return 'utm';
    }
    
    // Check for Transverse Mercator
    if (label.includes('transverse mercator') || proj4def.includes('+proj=tmerc')) {
      return 'tm';
    }
    
    // Check for Lambert Conformal Conic
    if (label.includes('lambert') || proj4def.includes('+proj=lcc')) {
      return 'conic';
    }
    
    // All other projected systems
    if (crs.type === 'projected') {
      return 'projected';
    }
    
    return 'other';
  };

  const isRecommendedForCountry = (crs, country, category) => {
    const text = `${crs.label || ''} ${crs.region || ''} ${crs.code || ''}`.toLowerCase();

    // Global generic cleanup for country-level operational lists
    const isCompoundOrVertical =
      text.includes(' + ') ||
      /\b(height|depth|vertical|geocentric|geoid|gravity|engineering|3d|2d\+1d)\b/i.test(text);
    if (isCompoundOrVertical) return false;

    // Avoid non-usable buckets in recommended view
    if (category === 'other') return false;

    // Prefer onshore systems if entry is purely offshore
    const hasOffshore = text.includes('offshore');
    const hasOnshore = text.includes('onshore');
    if (hasOffshore && !hasOnshore) return false;

    // Country-specific preferred families (France)
    if (country === 'France') {
      const isLambert93 = text.includes('lambert-93') || text.includes('lambert 93');
      const isCC = /\bcc(4[2-9]|50)\b/i.test(text);
      const isLambertZone = /lambert\s*zone\s*(i|ii|iii|iv|1|2|3|4)/i.test(text);
      return isLambert93 || isCC || isLambertZone;
    }

    // For all other countries, generic recommended rules above are enough
    return true;
  };

  // Filter CRS based on search and type
  const filteredCrs = useMemo(() => {
    return CRS_LIST.filter(crs => {
      const category = getCrsCategory(crs);

      // Filter by search
      if (search) {
        const searchLower = search.toLowerCase();
        const matches =
          crs.code.toLowerCase().includes(searchLower) ||
          crs.label.toLowerCase().includes(searchLower) ||
          crs.region.toLowerCase().includes(searchLower);
        if (!matches) return false;
      }

      // Filter by type
      if (filter !== 'all') {
        // Special handling for "Projected" - includes all projected types
        if (filter === 'projected') {
          if (category === 'geographic' || category === 'other') return false;
        } else {
          // Specific type filters
          if (category !== filter) return false;
        }
      }

      // Filter by continent
      if (continentFilter !== 'all') {
        const crsCountries = detectCountries(crs);
        const matchesContinent = crsCountries.some((country) => {
          const continent = COUNTRY_TO_CONTINENT[country] || 'Other';
          return continent === continentFilter;
        });
        if (!matchesContinent) return false;
      }

      // Filter by country
      if (countryFilter !== 'all') {
        const crsCountries = detectCountries(crs);
        if (!crsCountries.includes(countryFilter)) return false;

        // Keep country selection focused on country-specific CRS only.
        // This excludes broad multi-country/world CRS when a country is selected.
        if (crsCountries.length > 1) return false;

        if (recommendedOnly && !isRecommendedForCountry(crs, countryFilter, category)) return false;
      }

      return true;
    }).slice(0, 300); // Keep enough rows for country catalogs like France/Australia
  }, [search, filter, continentFilter, countryFilter, recommendedOnly]);

  // Get current CRS object
  const currentCrs = CRS_LIST.find(c => c.code === value);

  // Toggle favorite
  const toggleFavorite = (crsCode) => {
    setFavorites(prev => {
      const newFavorites = prev.includes(crsCode)
        ? prev.filter(c => c !== crsCode)
        : [...prev, crsCode];
      localStorage.setItem('crs_favorites', JSON.stringify(newFavorites));
      return newFavorites;
    });
  };

  // Handle selection
  const handleSelect = (crsCode) => {
    onChange(crsCode);
    
    // Add to recent
    setRecent(prev => {
      const newRecent = [crsCode, ...prev.filter(c => c !== crsCode)].slice(0, 10);
      localStorage.setItem('crs_recent', JSON.stringify(newRecent));
      return newRecent;
    });

    setSearch('');
    setIsOpen(false);
  };

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Get favorite CRS objects
  const favoriteCrs = CRS_LIST.filter(c => favorites.includes(c.code)).slice(0, 5);
  const recentCrs = CRS_LIST.filter(c => recent.includes(c.code)).slice(0, 5);
  const hasActiveFilters = search || filter !== 'all' || continentFilter !== 'all' || countryFilter !== 'all';

  const clearAllFilters = () => {
    setSearch('');
    setFilter('all');
    setContinentFilter('all');
    setCountryFilter('all');
    setRecommendedOnly(true);
    setHighlightedIndex(-1);
  };

  const scrollToHighlighted = (index) => {
    const list = scrollContainerRef.current;
    if (!list || index < 0) return;
    const item = list.querySelector(`[data-result-index="${index}"]`);
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      return;
    }

    if (!hasActiveFilters || filteredCrs.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = highlightedIndex < filteredCrs.length - 1 ? highlightedIndex + 1 : 0;
      setHighlightedIndex(nextIndex);
      scrollToHighlighted(nextIndex);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = highlightedIndex > 0 ? highlightedIndex - 1 : filteredCrs.length - 1;
      setHighlightedIndex(prevIndex);
      scrollToHighlighted(prevIndex);
      return;
    }

    if (e.key === 'Enter' && highlightedIndex >= 0 && filteredCrs[highlightedIndex]) {
      e.preventDefault();
      handleSelect(filteredCrs[highlightedIndex].code);
    }
  };

  return (
    <div className="crs-search-selector" ref={containerRef}>
      {label && <label className="crs-label">{label}</label>}

      {/* Display selected CRS */}
      <div
        className="crs-display-box"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsOpen((prev) => !prev);
          }
          if (e.key === 'ArrowDown' && !isOpen) {
            e.preventDefault();
            setIsOpen(true);
          }
          if (e.key === 'Escape' && isOpen) {
            e.preventDefault();
            setIsOpen(false);
          }
        }}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        tabIndex={0}
      >
        <div className="crs-display-main">
          <div className="crs-display-code">
            {currentCrs ? currentCrs.code : 'Select CRS'}
          </div>
          <div className="crs-display-label-text" title={currentCrs ? currentCrs.label : 'Type to search...'}>
            {currentCrs ? currentCrs.label : 'Type to search...'}
          </div>
        </div>
        <div className="crs-display-arrow">▼</div>
      </div>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="crs-dropdown">
          {/* Search input */}
          <input
            type="text"
            placeholder="Search code, name, or region..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="crs-search-input"
            aria-label="Search CRS by code, name, or region"
            autoFocus
          />

          {/* Filter buttons */}
          <div className="crs-filter-buttons">
            {['all', 'geographic', 'projected', 'utm', 'tm', 'conic'].map(cat => (
              <button
                key={cat}
                onClick={() => setFilter(cat)}
                className={`filter-btn ${filter === cat ? 'active' : ''}`}
              >
                {cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            ))}
          </div>

          {/* Continent filter dropdown */}
          <div className="crs-country-filter">
            <label>Continent:</label>
            <select
              value={continentFilter}
              onChange={(e) => {
                setContinentFilter(e.target.value);
                setCountryFilter('all');
              }}
              className="country-select"
            >
              {continents.map((continent) => (
                <option key={continent} value={continent}>
                  {continent === 'all' ? 'All Continents' : continent}
                </option>
              ))}
            </select>
          </div>

          {/* Country filter dropdown */}
          <div className="crs-country-filter">
            <label>Filter by Country:</label>
            <select 
              value={countryFilter} 
              onChange={(e) => {
                setCountryFilter(e.target.value);
                setRecommendedOnly(true);
              }}
              className="country-select"
            >
              <option value="all">All Countries</option>
              {allCountries.map(({ country }) => (
                <option key={country} value={country}>{country}</option>
              ))}
            </select>
          </div>

          {countryFilter !== 'all' && (
            <div className="crs-recommended-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={recommendedOnly}
                  onChange={(e) => setRecommendedOnly(e.target.checked)}
                />
                Recommended for {countryFilter}
              </label>
              <span className="crs-recommended-hint">Uncheck to show all CRS for this country</span>
            </div>
          )}

          {hasActiveFilters && (
            <div className="crs-clear-filters-row">
              <button type="button" className="crs-clear-filters-btn" onClick={clearAllFilters}>
                Clear Filters
              </button>
            </div>
          )}

          {/* Favorites section */}
          {!hasActiveFilters && favoriteCrs.length > 0 && (
            <div className="crs-section">
              <div className="crs-section-title">⭐ Favorites</div>
              <div className="crs-list">
                {favoriteCrs.map(crs => (
                  <div
                    key={crs.code}
                    className={`crs-item ${value === crs.code ? 'selected' : ''}`}
                    onClick={() => handleSelect(crs.code)}
                  >
                    <div className="crs-item-main">
                      <strong>{crs.code}</strong>
                      <span className="crs-item-label">{crs.label}</span>
                      <span className="crs-item-country">{detectCountries(crs).join(', ')}</span>
                    </div>
                    <button
                      className="favorite-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(crs.code);
                      }}
                      title="Remove from favorites"
                    >
                      ⭐
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent section */}
          {!hasActiveFilters && recentCrs.length > 0 && (
            <div className="crs-section">
              <div className="crs-section-title">🕐 Recently Used</div>
              <div className="crs-list">
                {recentCrs.map(crs => (
                  <div
                    key={crs.code}
                    className={`crs-item ${value === crs.code ? 'selected' : ''}`}
                    onClick={() => handleSelect(crs.code)}
                  >
                    <div className="crs-item-main">
                      <strong>{crs.code}</strong>
                      <span className="crs-item-label">{crs.label}</span>
                      <span className="crs-item-country">{detectCountries(crs).join(', ')}</span>
                    </div>
                    <button
                      className="favorite-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(crs.code);
                      }}
                      title="Add to favorites"
                    >
                      ☆
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Search results */}
          {hasActiveFilters && (
            <div className="crs-section crs-results-section">
              <div className="crs-section-title">
                Results ({filteredCrs.length} found)
                {(countryFilter !== 'all' || continentFilter !== 'all') && (
                  <span className="crs-results-info">
                    {`${filter !== 'all' ? filter : 'all'} | ${continentFilter !== 'all' ? continentFilter : 'all continents'} | ${countryFilter !== 'all' ? countryFilter : 'all countries'}`}
                  </span>
                )}
              </div>
              <div className="crs-list" ref={scrollContainerRef} id={listboxId} role="listbox" aria-label="Filtered CRS results">
                {filteredCrs.length > 0 ? (
                  filteredCrs.map((crs, index) => (
                    <div
                      key={crs.code}
                      className={`crs-item ${value === crs.code ? 'selected' : ''} ${highlightedIndex === index ? 'highlighted' : ''}`}
                      data-result-index={index}
                      role="option"
                      aria-selected={value === crs.code}
                      onClick={() => handleSelect(crs.code)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                    >
                      <div className="crs-item-main">
                        <strong>{crs.code}</strong>
                        <span className="crs-item-label">{crs.label}</span>
                        {crs.region && (
                          <>
                            <span className="crs-item-region">{crs.region}</span>
                            <span className="crs-item-country">{detectCountries(crs).join(', ')}</span>
                          </>
                        )}
                      </div>
                      <button
                        className="favorite-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(crs.code);
                        }}
                        title={
                          favorites.includes(crs.code)
                            ? 'Remove from favorites'
                            : 'Add to favorites'
                        }
                      >
                        {favorites.includes(crs.code) ? '⭐' : '☆'}
                      </button>
                    </div>
                  ))
                ) : (
                  <div style={{ padding: '1rem', color: '#999' }}>
                    No CRS found matching your search.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
