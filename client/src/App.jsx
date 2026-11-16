import React from 'react';
import { ErrorBoundary } from '@krusch/toolkit/react';
import HydraScopeCockpit from './components/HydraScopeCockpit.jsx';
import './styles.css';

export default function App() {
    return (
        <ErrorBoundary>
            <HydraScopeCockpit />
        </ErrorBoundary>
    );
}
