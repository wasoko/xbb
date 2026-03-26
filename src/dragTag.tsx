import React, { RefObject, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, PanInfo, useMotionValue, useTransform } from 'framer-motion';
export function DragTag({current, options, onSelect, onLeft=()=>{}, canReplace=false, ...passProps}
  :{current:string, options:string[]
    , onSelect:(item:string, prev:string)=>void
    , onLeft?:(item:string)=>void, canReplace?:boolean, drag?:string|boolean }){
  const [isOpen, setIsOpen] = useState(false);
  const [isLeft, set_isLeft] = useState(false);
  const [isRight, set_isRight] = useState(false);
  const [selected, setSelected] = useState(current);
  const [hiopt, sethiopt] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  
  // Fixed: Pass both refs to detect clicks outside both elements
  usePointerOutside([ref, menuRef], ()=>setIsOpen(false));
  
  // Track dragging state (works for both touch and mouse)
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {    if (!isOpen) return;
    const handlePointerMove = (e: TouchEvent | MouseEvent) => {
      setIsDragging(true);
      let clientX: number, clientY: number;
      if (e instanceof TouchEvent) {
        const touch = e.touches[0];
        clientX = touch.clientX;
        clientY = touch.clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }
      const element = document.elementFromPoint(clientX, clientY);
      const optionValue = element?.getAttribute('data-option');
      if (optionValue) {
        sethiopt(optionValue);
      } else {
        sethiopt('');
      }
    };
    const handlePointerEnd = () => {
      if (isDragging && hiopt) handleReleaseSelect(hiopt)
      setIsDragging(false);
    };
    window.addEventListener('touchmove', handlePointerMove as any, { passive: false });
    window.addEventListener('touchend', handlePointerEnd);
    window.addEventListener('mousemove', handlePointerMove as any);
    window.addEventListener('mouseup', handlePointerEnd)
    return () => {
      window.removeEventListener('touchmove', handlePointerMove as any);
      window.removeEventListener('touchend', handlePointerEnd);
      window.removeEventListener('mousemove', handlePointerMove as any);
      window.removeEventListener('mouseup', handlePointerEnd);
    };
  }, [isOpen, hiopt, isDragging]);
  
  const handleReleaseSelect = (item: string) => {
    if (onSelect) onSelect(item, selected)
    if (canReplace) setSelected(item);
    setIsOpen(false);
  };
  const X_LEFT = -10
  const handleDrag = (_: any, info: PanInfo) => {
    console.log(info)
    if (info.offset.x < X_LEFT) setIsOpen(false);
    set_isLeft(info.offset.x < X_LEFT)
  };
  const handleDragStart = (_: any, info: PanInfo) => {
    set_isLeft(info.offset.x<0)
    set_isRight(info.offset.x>0)
  }
  const handleDragEnd = (_: any, info: PanInfo) => {
    console.log(info)
    if (info.offset.x < X_LEFT) onLeft(current);
    set_isLeft(false)
  };
  const x = useMotionValue(0);
  const borderWidth = useTransform(x, [X_LEFT-1, X_LEFT,0], [5, 5, 0]); // FIXME
  return (
    <AnimatePresence>
    <div ref={ref} onPointerOver={() => setIsOpen(true)} style={{ display: 'flex', flexDirection: 'column'
    ,zIndex: 20 , alignItems: 'flex-end', position: 'relative', cursor: 'pointer' }}>
      <motion.button dragSnapToOrigin={true} {...passProps} // drag "x" / false
        dragConstraints={{ left: -55, right: 55 }} dragElastic={0.1}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd} //whileTap={{ scale: 0.9 }}
        // whileDrag={{ cursor:'grabbing',scale: 1.05, boxShadow: "0px 10px 20px rgba(0,0,0,0.3)" }}
        // {{ opacity: 0.8, backdropFilter: "blur(4px)", zIndex:333 }}
        style={{ display:'flex',flexDirection:'row',  padding: '0.5rem 1.5rem',borderRadius:'50vh',
          borderWidth, borderStyle:'solid' }} > 
           {selected} {isLeft && "..."} 
        <div onPointerDownCapture={(e) => e.stopPropagation()} style={{paddingLeft:'7px'}}
        onClick={()=>onLeft(current)}> &#x2710;&#xFE0F; </div>
        
      </motion.button> 
      {isOpen && (
        <div 
          ref={menuRef}
          // style={{  position: 'fixed',  top: '100%',  left: '50%', 
          //   transform: 'translateX(-50%)', // Centers menu regardless of width
          //   minWidth: '100%' //
            style={{ position: 'fixed',top:'31px', textAlign:'right', zIndex: 220 
            }} 
          // initial={{ opacity: 0, y: -10 }}
          // animate={{ opacity: 1, y: 0 }} 
          > 
          {options.map((item) => ( <div key={item} data-option={item} // Required for document.elementFromPoint
              // Selection: Triggers on pointer release
              onClick={() => handleReleaseSelect(item)}
              onPointerEnter={()=>sethiopt(item)}
              style={{  padding: '10px',
                // The single state handles styling for all items correctly
                backgroundColor: hiopt === item ? 'var(--bt-color)' : 'transparent',
                color: hiopt === item ?'black': 'white' ,
                
                  // pointerEvents: 'auto', // Ensure items can be hit-tested
                   }} >
              {item} </div>
          ))} </div>
      )}</div>
      </AnimatePresence>
  );
};
export const ToggleBox = ({ children }) => (
  <details> <summary style={{ cursor: 'pointer', listStyle: 'none' }}>Show</summary>
    {children} </details>
);

function useClickOutside(
  refs: RefObject<HTMLElement | undefined> | RefObject<HTMLElement | undefined>[],
  callback: () => void, addEventListener = true,
) {
  function handleClick(event: MouseEvent) {
    const refArray = Array.isArray(refs) ? refs : [refs];
    const isOutside = refArray.every(ref => 
      !ref.current || !ref.current.contains(event.target as HTMLElement)
    );
    if (isOutside) callback();
  }
  useEffect(() => { 
    if (addEventListener) document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  });
}
function usePointerOutside(
  refs: RefObject<HTMLElement | undefined> | RefObject<HTMLElement | undefined>[],
  callback: () => void, addEventListener = true,
) {
  function handleClick(event: MouseEvent) {
    const refArray = Array.isArray(refs) ? refs : [refs];
    const isOutside = refArray.every(ref => 
      !ref.current || !ref.current.contains(event.target as HTMLElement)
    );
    if (isOutside) callback();
  }
  useEffect(() => { 
    if (addEventListener) document.addEventListener('pointerover', handleClick);
    return () => document.removeEventListener('pointerover', handleClick);
  });
}
 // https://coreui.io/blog/how-to-detect-a-click-outside-of-a-react-component/

