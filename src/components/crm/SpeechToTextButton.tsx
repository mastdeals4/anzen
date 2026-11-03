import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { showToast } from '../ToastNotification';

interface Props {
  onTranscript: (text: string) => void;
  language?: 'id-ID' | 'en-US';
  className?: string;
}

export function SpeechToTextButton({
  onTranscript,
  language = 'id-ID',
  className = '',
}: Props) {
  const [isListening, setIsListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;

    recognition.onresult = (event: any) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
        }
      }
      if (finalTranscript.trim()) {
        onTranscript(finalTranscript.trim());
      }
    };

    recognition.onerror = (event: any) => {
      console.warn('[SpeechToText] Recognition error:', event.error);
      setIsListening(false);
      if (event.error !== 'no-speech') {
        showToast({
          type: 'warning',
          title: 'Speech Recognition',
          message: `Microphone notice: ${event.error}`,
        });
      }
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, [language, onTranscript]);

  const toggleListening = () => {
    if (!supported) {
      showToast({
        type: 'warning',
        title: 'Voice Dictation Unavailable',
        message: 'Your browser does not support the Web Speech Recognition API. Please use Chrome or Edge.',
      });
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current?.start();
        setIsListening(true);
        showToast({
          type: 'info',
          title: 'Microphone Active',
          message: 'Dictate your call or meeting notes now...',
        });
      } catch (err: any) {
        console.error('[SpeechToText] Start error:', err);
      }
    }
  };

  return (
    <button
      type="button"
      onClick={toggleListening}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold transition cursor-pointer select-none ${
        isListening
          ? 'bg-rose-600 text-white animate-pulse shadow-sm'
          : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 hover:text-gray-900'
      } ${className}`}
      title={isListening ? 'Stop Dictating' : 'Dictate note with microphone'}
    >
      {isListening ? (
        <>
          <MicOff className="w-3.5 h-3.5 text-white" />
          <span>Listening...</span>
        </>
      ) : (
        <>
          <Mic className="w-3.5 h-3.5 text-blue-600" />
          <span>Dictate</span>
        </>
      )}
    </button>
  );
}

export default SpeechToTextButton;

