import {
    ChangeEvent,
    Fragment,
    RefObject,
    useCallback,
    useEffect,
    useState,
} from "react";
import type { Config } from "ruffle-core";

type SampleCategory = "Animation" | "Game";

const SampleCategories: { [key in SampleCategory]: string } = {
    Animation: "Animations",
    Game: "Games",
};

export interface DemoSwf {
    location: string;
    title?: string;
    author?: string;
    authorLink?: string;
    config?: Config.BaseLoadOptions;
    type?: SampleCategory;
}

interface SampleSelectionProperties {
    sampleSelectionInput: RefObject<HTMLSelectElement | null>;
    selectedSample: DemoSwf | null;
    setSelectedSample: (value: DemoSwf | null) => void;
    setSelectedFilename: (name: string | null) => void;
    onSelectUrl: (url: string, config: Config.BaseLoadOptions) => void;
}

export function SampleSelection({
    sampleSelectionInput,
    selectedSample,
    setSelectedSample,
    setSelectedFilename,
    onSelectUrl,
}: SampleSelectionProperties) {
    const [availableSamples, setAvailableSamples] = useState<DemoSwf[]>([]);

    const loadSelectedSample = (e: ChangeEvent) => {
        const eventTarget = e.target as HTMLSelectElement;
        const index = parseInt(eventTarget.value, 10);
        if (availableSamples[index]) {
            loadSample(availableSamples[index]);
            window.history.replaceState(
                null,
                "",
                `${window.location.pathname}?file=${availableSamples[index].location}`,
            );
        }
    };

    const loadSample = useCallback(
        (swf: DemoSwf) => {
            onSelectUrl(swf.location, swf.config ?? {});
            setSelectedSample(swf);
            setSelectedFilename(null);
        },
        [onSelectUrl, setSelectedFilename, setSelectedSample],
    );

    useEffect(() => {
        (async () => {
            const params = new URLSearchParams(window.location.search);

            // A direct `?url=` takes priority over the sample list. This also
            // allows loading non-SWF content such as AIR application
            // descriptors.
            const urlParam = params.get("url");
            if (urlParam) {
                onSelectUrl(urlParam, {});
                return;
            }

            const response = await fetch("swfs.json");

            if (response.ok) {
                const data: { swfs: DemoSwf[] } = await response.json();
                setAvailableSamples(data.swfs);

                if (data.swfs.length > 0) {
                    const fileParam = params.get("file");

                    let sampleIndex = 0;

                    if (fileParam) {
                        sampleIndex = data.swfs.findIndex(
                            (swf) => swf.location === fileParam,
                        );
                        if (sampleIndex === -1) {
                            sampleIndex = 0;
                        }
                    }

                    loadSample(data.swfs[sampleIndex]);
                    requestAnimationFrame(() => {
                        if (sampleSelectionInput.current) {
                            sampleSelectionInput.current.selectedIndex =
                                sampleIndex;
                        }
                    });
                }
            }
        })();
    }, [loadSample, onSelectUrl, sampleSelectionInput]);

    return (
        <div
            id="sample-swfs-container"
            className={availableSamples.length === 0 ? "hidden" : ""}
        >
            <span id="sample-swfs-label">Sample SWF:</span>
            <select
                id="sample-swfs"
                aria-describedby="sample-swfs-label"
                onChange={loadSelectedSample}
                ref={sampleSelectionInput}
            >
                {availableSamples.map((sample, i) => (
                    <Fragment key={i}>
                        {sample.type === undefined && (
                            <option value={i}>{sample.title}</option>
                        )}
                    </Fragment>
                ))}
                {Object.keys(SampleCategories).map((category) => (
                    <optgroup
                        key={category}
                        label={SampleCategories[category as SampleCategory]}
                    >
                        {availableSamples.map((sample, i) => (
                            <Fragment key={i}>
                                {sample.type === category && (
                                    <option value={i}>{sample.title}</option>
                                )}
                            </Fragment>
                        ))}
                    </optgroup>
                ))}
            </select>
            <div
                id="author-container"
                className={selectedSample?.author ? "" : "hidden"}
            >
                <span>Author: </span>
                <a
                    href={selectedSample?.authorLink}
                    target="_blank"
                    id="author"
                >
                    {selectedSample?.author}
                </a>
            </div>
        </div>
    );
}
