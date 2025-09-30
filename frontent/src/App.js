import React, { useState } from "react";
import Upload from "./components/Upload";
import TranscriptStream from "./components/TranscriptStream";

function App() {
  const [file, setFile] = useState(null);
  // This state holds the raw JSON objects from the stream.
  const [streamData, setStreamData] = useState([]);

  return (
    <div className="p-6 min-h-screen bg-gray-100">
      <header className="text-center py-6 bg-white shadow-xl rounded-xl">
        <h1 className="text-4xl font-extrabold text-blue-900">AI Meeting Intelligence</h1>
        <p className="text-lg text-gray-500 mt-1">Real-time transcription, summarization, and insight extraction.</p>
      </header>
      
      <main className="max-w-4xl mx-auto mt-8">
        {/* The Upload component handles the file selection and upload process */}
        <Upload setFile={setFile} setStreamData={setStreamData} />
        
        {/* Render the streaming component only after a file has been successfully uploaded */}
        {file && <TranscriptStream file={file} setStreamData={setStreamData} />}
      </main>
    </div>
  );
}

export default App;
