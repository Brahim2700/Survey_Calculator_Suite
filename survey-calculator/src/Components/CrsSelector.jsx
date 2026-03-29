import { useEffect, useMemo, useRef, useState } from "react";
import CRS_LIST from "../crsList";

const MAX_RESULTS = 150; // cap results so dropdown stays performant

const CrsSelector = ({ label, value, onChange, inputId }) => {
  const containerRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const selected = useMemo(
    () => CRS_LIST.find((crs) => crs.code === value),
    [value]
  );

  const selectedLabel = selected ? `${selected.code} - ${selected.label}` : "";
  const displayValue = isOpen ? searchTerm : selectedLabel;

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const filtered = useMemo(() => {
    const activeTerm = isOpen ? searchTerm : "";
    const query = activeTerm.trim().toLowerCase();
    if (query.length === 0) {
      return CRS_LIST.slice(0, MAX_RESULTS);
    }

    return CRS_LIST.filter((crs) => {
      const haystack = `${crs.code} ${crs.label} ${crs.region || ""}`.toLowerCase();
      return haystack.includes(query);
    }).slice(0, MAX_RESULTS);
  }, [isOpen, searchTerm]);

  const handlePick = (crs) => {
    onChange(crs.code);
    setIsOpen(false);
    setSearchTerm("");
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: "0.35rem"
      }}
    >
      <label htmlFor={inputId} style={{ fontWeight: "bold" }}>
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        value={displayValue}
        placeholder="Search by EPSG code, country, or name"
        onChange={(event) => {
          setSearchTerm(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => {
          setIsOpen(true);
          setSearchTerm(selectedLabel);
        }}
        style={{
          padding: "0.45rem 0.65rem",
          borderRadius: "4px",
          border: "1px solid #999",
          width: "100%",
          boxSizing: "border-box"
        }}
      />
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            width: "100%",
            marginTop: "0.2rem",
            maxHeight: "240px",
            overflowY: "auto",
            backgroundColor: "#fff",
            border: "1px solid #ccc",
            borderRadius: "6px",
            boxShadow: "0 8px 18px rgba(0,0,0,0.12)",
            zIndex: 5
          }}
        >
          {filtered.length === 0 && (
            <div
              style={{
                padding: "0.6rem 0.75rem",
                fontSize: "0.85rem",
                color: "#666"
              }}
            >
              No CRS matches this search.
            </div>
          )}
          {filtered.map((crs) => {
            const isActive = crs.code === value;
            return (
              <button
                key={crs.code}
                type="button"
                onClick={() => handlePick(crs)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "0.45rem 0.65rem",
                  border: "none",
                  backgroundColor: isActive ? "#e5f0ff" : "transparent",
                  cursor: "pointer"
                }}
              >
                <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                  {crs.code}
                </div>
                <div style={{ fontSize: "0.85rem", color: "#333" }}>
                  {crs.label}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CrsSelector;
