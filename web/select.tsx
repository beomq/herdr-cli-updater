import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './select.css';

export type SelectOption<T extends string> = { readonly value:T; readonly label:string; readonly description?:string; readonly disabled?:boolean };
type Props<T extends string> = { readonly label:string; readonly value:T; readonly options:readonly SelectOption<T>[]; readonly onChange:(value:T)=>void; readonly disabled?:boolean; readonly side?:'vertical'|'right' };

export function Select<T extends string>({label,value,options,onChange,disabled=false,side='vertical'}:Props<T>) {
  const id=React.useId();
  const trigger=useRef<HTMLButtonElement>(null);
  const menu=useRef<HTMLDivElement>(null);
  const search=useRef({text:'',time:0});
  const [open,setOpen]=useState(false);
  const [active,setActive]=useState(0);
  const [placement,setPlacement]=useState({left:0,top:0,width:0,maxHeight:280});
  const selected=options.find(option=>option.value===value);
  const enabled=options.map((option,index)=>({option,index})).filter(item=>!item.option.disabled);
  const show=()=>{if(disabled||!enabled.length)return;setActive(options.findIndex(option=>option.value===value&&!option.disabled)>=0?options.findIndex(option=>option.value===value):enabled[0]?.index??0);setOpen(true);};
  const choose=(index:number)=>{const option=options[index];if(!option||option.disabled)return;onChange(option.value);setOpen(false);trigger.current?.focus();};
  useLayoutEffect(()=>{
    if(!open||!trigger.current)return;
    const rect=trigger.current.getBoundingClientRect();
    const rightWidth=Math.max(240,rect.width);
    if(side==='right'&&window.innerWidth>768&&rect.right+8+rightWidth<=window.innerWidth-8){
      if(menu.current)menu.current.style.width=`${rightWidth}px`;
      const maxHeight=Math.min(480,window.innerHeight-16);
      const height=Math.min(menu.current?.scrollHeight??maxHeight,maxHeight);
      setPlacement({left:rect.right+8,top:Math.max(8,Math.min(rect.top,window.innerHeight-8-height)),width:rightWidth,maxHeight});
      return;
    }
    const width=Math.min(rect.width,window.innerWidth-16);
    if(menu.current)menu.current.style.width=`${width}px`;
    const below=window.innerHeight-rect.bottom-14;
    const above=rect.top-14;
    const height=Math.min(280,Math.max(below,above));
    const measured=Math.min(menu.current?.scrollHeight??height,height);
    const down=below>=Math.min(280,menu.current?.scrollHeight??280)||below>=above;
    setPlacement({left:Math.min(Math.max(8,rect.left),window.innerWidth-width-8),top:down?rect.bottom+6:rect.top-6-measured,width,maxHeight:Math.min(280,Math.max(44,down?below:above))});
  },[open,options,side]);
  useEffect(()=>{if(open)menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({block:'nearest'});},[active,open]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!trigger.current?.contains(event.target)&&!menu.current?.contains(event.target))setOpen(false);};
    const close=()=>setOpen(false);
    const scroll=(event:Event)=>{if(event.target instanceof Node&&menu.current?.contains(event.target))return;setOpen(false);};
    document.addEventListener('pointerdown',outside,true);
    window.addEventListener('resize',close);
    document.addEventListener('scroll',scroll,true);
    return()=>{document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',close);document.removeEventListener('scroll',scroll,true);};
  },[open]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  const keyDown=(event:React.KeyboardEvent<HTMLButtonElement>)=>{
    if(event.key==='Tab'){setOpen(false);return;}
    if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();if(!open){show();return;}
      const position=enabled.findIndex(item=>item.index===active);
      const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:(position+(event.key==='ArrowDown'?1:-1)+enabled.length)%enabled.length;
      setActive(enabled[next]?.index??active);return;
    }
    if(event.key==='Enter'||event.key===' '){event.preventDefault();if(open)choose(active);else show();return;}
    if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      event.preventDefault();const now=performance.now();search.current={text:(now-search.current.time<700?search.current.text:'')+event.key.toLocaleLowerCase(),time:now};
      const match=enabled.find(item=>item.option.label.toLocaleLowerCase().startsWith(search.current.text));
      if(!open)show();if(match)setActive(match.index);
    }
  };
  const popup=open&&<div ref={menu} id={id+'-list'} role="listbox" aria-labelledby={id+'-label'} className="select-menu" style={placement}>{options.map((option,index)=><div key={option.value} id={id+'-'+index} role="option" aria-selected={option.value===value} aria-disabled={option.disabled||undefined} data-active={active===index} data-index={index} className="select-option" onPointerMove={()=>{if(!option.disabled)setActive(index);}} onPointerDown={event=>event.preventDefault()} onClick={()=>choose(index)}><span><span className="select-option-label">{option.label}</span>{option.description&&<span className="select-description">{option.description}</span>}</span><svg viewBox="0 0 20 20" aria-hidden="true" className="select-check" style={{visibility:option.value===value?'visible':'hidden'}}><path d="m4 10 4 4 8-8"/></svg></div>)}</div>;
  return <div className="field custom-select"><span id={id+'-label'}>{label}</span><button ref={trigger} type="button" role="combobox" aria-labelledby={id+'-label'} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?id+'-list':undefined} aria-activedescendant={open?id+'-'+active:undefined} disabled={disabled||!enabled.length} className="select-trigger" onClick={()=>open?setOpen(false):show()} onKeyDown={keyDown} onBlur={()=>setOpen(false)}><span>{selected?.label??value}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg></button>{popup&&createPortal(popup,trigger.current?.closest('dialog')??document.body)}</div>;
}
