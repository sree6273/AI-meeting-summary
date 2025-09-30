import React, { useState, useReducer, useRef, useEffect, useCallback } from "react";

// --- State Management with Reducer for Atomic Updates ---
const initialState = {
  transcript: "",
  summary: "",
  statusMessage: "Upload an audio or video file to begin.",
  error: null,
  isProcessing: false,
};

function streamReducer(state, action) {
  switch (action.type) {
    case 'START':
      return { ...initialState, isProcessing: true, statusMessage: "File uploading...", error: null };
    case 'UPDATE_STATUS':
      return { ...state, statusMessage: action.payload };
    case 'APPEND_TRANSCRIPT':
      // Append text, ensuring a space precedes the new chunk if content exists
      const newTranscriptPart = state.transcript.length > 0 ? ' ' + action.payload : action.payload;
      return { ...state, transcript: state.transcript + newTranscriptPart };
    case 'APPEND_SUMMARY':
      // Append text, ensuring a space precedes the new chunk if content exists
      const newSummaryPart = state.summary.length > 0 ? ' ' + action.payload : action.payload;
      return { ...state, summary: state.summary + newSummaryPart };
    case 'COMPLETE':
      return { ...state, isProcessing: false, statusMessage: action.payload || state.statusMessage };
    case 'ERROR':
      return { ...state, isProcessing: false, error: action.payload, statusMessage: `❌ Error: ${action.payload}` };
    default:
      return state;
  }
}

const FileUpload = () => {
  const [file, setFile] = useState(null);
  const [state, dispatch] = useReducer(streamReducer, initialState);
  
  // Refs for automatic scrolling and stream control
  const transcriptRef = useRef(null);
  const summaryRef = useRef(null);
  const abortControllerRef = useRef(null); // To manage network stream closure

  const scrollToBottom = (ref) => {
    requestAnimationFrame(() => {
        if (ref.current) {
            ref.current.scrollTop = ref.current.scrollHeight;
        }
    });
  };

  // Effects for scrolling whenever content changes
  useEffect(() => { scrollToBottom(transcriptRef); }, [state.transcript]);
  useEffect(() => { scrollToBottom(summaryRef); }, [state.summary]);

  // --- File Handling ---
  const handleFileChange = (event) => {
    if (state.isProcessing) return;
    const selectedFile = event.target.files[0];
    setFile(selectedFile);
    dispatch({ type: 'COMPLETE', payload: selectedFile ? `File selected: ${selectedFile.name}. Ready to analyze.` : "Upload an audio or video file to begin." });
  };

  // --- Upload and Stream Analysis Logic ---
  const handleUploadAndAnalyze = useCallback(async () => {
    if (!file || state.isProcessing) return;

    // 1. Initialize State and Stream Control
    dispatch({ type: 'START' });
    abortControllerRef.current = new AbortController();
    const { signal } = abortControllerRef.current;
    
    const formData = new FormData();
    formData.append("file", file);
    
    let isStreamSuccessful = false;
    let reader = null; 

    try {
      // --- Step 1: Upload File ---
      dispatch({ type: 'UPDATE_STATUS', payload: "Uploading file to server..." });

      const uploadRes = await fetch("http://localhost:8000/upload-meeting/", {
        method: "POST",
        body: formData,
        signal: signal,
      });

      if (!uploadRes.ok) {
        throw new Error(`Upload failed with status ${uploadRes.status}`);
      }
      
      // --- Step 2: Start Fetch Streaming ---
      dispatch({ type: 'UPDATE_STATUS', payload: "File uploaded. Starting processing stream..." });

      const streamRes = await fetch(`http://localhost:8000/transcribe-stream/${file.name}`, {
        method: 'GET',
        headers: { 'Accept': 'text/event-stream' },
        signal: signal,
      });

      if (!streamRes.ok || !streamRes.body) {
        throw new Error(`Stream request failed with status ${streamRes.status}`);
      }

      reader = streamRes.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // --- Step 3: Read and Process Stream Chunks ---
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          console.log("Stream reader finished.");
          break;
        }

        // Decode the incoming stream part and append to buffer
        buffer += decoder.decode(value, { stream: true });
        
        // Process all complete SSE messages in the buffer
        while (true) {
            const endOfMessage = buffer.indexOf('\n\n');
            if (endOfMessage === -1) break;

            const message = buffer.substring(0, endOfMessage).trim();
            buffer = buffer.substring(endOfMessage + 2);

            if (message.startsWith("data:")) {
                const dataString = message.substring(5).trim();
                
                // Handle [DONE] signal
                if (dataString === "[DONE]") {
                    isStreamSuccessful = true;
                    console.log("Received [DONE] signal. Stopping read loop.");
                    return; // Exit the function to go to cleanup
                }

                try {
                    const data = JSON.parse(dataString);
                    
                    if (data.tag === "STATUS") {
                        dispatch({ type: 'UPDATE_STATUS', payload: data.message });
                    }
                    // Handle backend ERROR tag
                    if (data.tag === "ERROR") {
                        throw new Error(data.message); 
                    }
                    if (data.transcript) {
                        dispatch({ type: 'APPEND_TRANSCRIPT', payload: data.transcript });
                    }
                    if (data.summary) {
                        dispatch({ type: 'APPEND_SUMMARY', payload: data.summary });
                    }
                } catch (e) {
                    // Log the error but continue reading, unless it's a fatal stream error
                    console.error("Failed to parse JSON or received backend ERROR:", dataString, e);
                }
            }
        }
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        console.log("Stream intentionally aborted during cleanup.");
      } else {
        console.error("Fatal Streaming Error:", err);
        dispatch({ type: 'ERROR', payload: err.message || "A fatal network or processing error occurred." });
      }
    } finally {
      // 4. Final Cleanup
      if (reader) {
          // If the reader is still active (e.g., terminated by error), cancel it
          await reader.cancel().catch(() => {});
      }
      
      // Set final status based on success flag
      if (isStreamSuccessful) {
        dispatch({ type: 'COMPLETE', payload: "✅ Analysis Complete. Full Report Available." });
      } else if (!state.error) {
        // If it exited without success or explicit error, treat it as interruption
        dispatch({ type: 'ERROR', payload: "The streaming connection was interrupted." });
      }
      
      // Ensure the network request is fully stopped
      if (abortControllerRef.current && !abortControllerRef.current.signal.aborted) {
        abortControllerRef.current.abort();
      }
    }
  }, [file, state.error]); 

  // --- Rendering ---
  const transcriptPlaceholder = state.isProcessing 
    ? "Transcription streaming in progress..." 
    : "Transcript will appear here...";

  const summaryPlaceholder = state.isProcessing
    ? "Summary generation in progress..."
    : "No summary yet.";


  return (
    <div className="p-6 max-w-4xl mx-auto font-sans bg-gray-50 min-h-screen">
      <h1 className="text-4xl font-extrabold text-center text-indigo-700 mb-2">AI Meeting Intelligence</h1>
      <p className="text-center text-gray-600 mb-8">Upload an audio or video file to generate smart meeting insights.</p>
      
      <div className="bg-white p-6 rounded-xl shadow-2xl mb-8 border border-gray-200">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">File Upload</h2>
        
        <div className="flex flex-col sm:flex-row items-center justify-between space-y-4 sm:space-y-0 sm:space-x-4">
            <input 
                type="file" 
                accept=".mp4,.mov,.mp3,.wav" 
                onChange={handleFileChange}
                className="w-full sm:w-auto text-sm text-gray-500
                    file:mr-4 file:py-2 file:px-4
                    file:rounded-full file:border-0
                    file:text-sm file:font-semibold
                    file:bg-indigo-50 file:text-indigo-700
                    hover:file:bg-indigo-100"
            />
            
            <button 
                onClick={handleUploadAndAnalyze} 
                disabled={!file || state.isProcessing}
                className={`py-2 px-6 rounded-full font-bold transition duration-300 w-full sm:w-auto
                    ${!file || state.isProcessing 
                        ? 'bg-gray-400 text-gray-600 cursor-not-allowed' 
                        : 'bg-indigo-600 text-white shadow-lg hover:bg-indigo-700'}`
                }
            >
                {state.isProcessing ? (
                    <span className="flex items-center justify-center">
                        <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        {state.statusMessage.split(':')[0] || "Processing..."}
                    </span>
                ) : (
                    "Upload & Analyze"
                )}
            </button>
        </div>
        
        {file && (
            <p className="mt-4 text-sm text-gray-500">
                Selected: <span className="font-medium text-gray-700">{file.name}</span>
            </p>
        )}
      </div>

      {/* --- Report Display --- */}
      <div className="bg-white p-6 rounded-xl shadow-2xl border border-gray-200">
        <h2 className="text-3xl font-bold mb-4 text-indigo-700">Meeting Intelligence Report</h2>
        
        <p className={`mb-4 p-3 rounded-lg font-semibold border ${state.error ? 'bg-red-50 text-red-700 border-red-200' : 'bg-green-50 text-green-700 border-green-200'}`}>
            {state.error ? `❌ ${state.error}` : state.statusMessage}
        </p>

        {/* Summary Section */}
        <h3 className="mt-6 text-xl font-bold text-gray-800 border-b pb-1">Summary</h3>
        <div 
            ref={summaryRef}
            className="whitespace-pre-wrap p-3 mt-2 bg-gray-50 border rounded-lg text-blue-800 h-24 overflow-y-auto text-sm"
        >
            {state.summary || summaryPlaceholder}
        </div>

        <h3 className="mt-6 text-xl font-bold text-gray-800 border-b pb-1">Key Decisions</h3>
        <p className="p-3 mt-2 bg-gray-50 border rounded-lg text-gray-500 italic text-sm">No key decisions yet.</p>

        <h3 className="mt-6 text-xl font-bold text-gray-800 border-b pb-1">Action Items</h3>
        <p className="p-3 mt-2 bg-gray-50 border rounded-lg text-gray-500 italic text-sm">No action items yet.</p>

        {/* Full Transcript Section */}
        <h3 className="mt-6 text-xl font-bold text-gray-800 border-b pb-1">Full Transcript</h3>
        <div 
            ref={transcriptRef}
            className="whitespace-pre-wrap p-3 mt-2 bg-gray-50 border rounded-lg h-48 overflow-y-scroll text-sm"
        >
            {state.transcript || transcriptPlaceholder}
        </div>
      </div>
    </div>
  );
};

export default FileUpload;
