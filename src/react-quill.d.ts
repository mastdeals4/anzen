declare module 'react-quill' {
  import React from 'react';

  export interface ReactQuillProps {
    value?: string;
    defaultValue?: string;
    placeholder?: string;
    readOnly?: boolean;
    theme?: string;
    modules?: any;
    formats?: string[];
    bounds?: string | HTMLElement;
    onChange?: (content: string, delta: any, source: string, editor: any) => void;
    onChangeSelection?: (selection: any, source: string, editor: any) => void;
    onFocus?: (selection: any, source: string, editor: any) => void;
    onBlur?: (previousSelection: any, source: string, editor: any) => void;
    onKeyPress?: React.EventHandler<any>;
    onKeyDown?: React.EventHandler<any>;
    onKeyUp?: React.EventHandler<any>;
    tabIndex?: number;
    className?: string;
    style?: React.CSSProperties;
    [key: string]: any;
  }

  export default class ReactQuill extends React.Component<ReactQuillProps> {}
}

declare module 'react-quill/dist/quill.snow.css';
