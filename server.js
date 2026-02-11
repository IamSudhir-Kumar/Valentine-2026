require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { PostHog } = require('posthog-node');

const posthogClient = new PostHog(
    'phc_YnDjzfeJA8MCJgLYMeTYsvSjVCAzMwiIqf8eWdw3jIC',
    { host: 'https://us.i.posthog.com' }
);

const app = express();
const port = 3000;
const cardDataDirPath = path.join(__dirname, 'card_data');

// Helper to normalize preset names from URL (kebab-case) to internal keys (PascalCase/camelCase)
const normalizePresetName = (presetNameFromUrl) => {
    // If it's 'valentine', it's already in the correct case for the JSON key and filename
    if (presetNameFromUrl === 'valentine') {
        return 'valentine';
    }
    // Convert kebab-case to PascalCase for other presets
    return presetNameFromUrl.split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');
};

function getCardDataFilePath(presetNameFromUrl) {
    const normalizedName = normalizePresetName(presetNameFromUrl);
    return path.join(cardDataDirPath, `${normalizedName}.json`);
}

// Initialize card_data directory and preset JSON files
if (!fs.existsSync(cardDataDirPath)) {
    fs.mkdirSync(cardDataDirPath);
}

const presets = JSON.parse(fs.readFileSync(path.join(__dirname, 'presets.json'), 'utf8'));

    console.log('Server initialization started.');

    for (const presetName in presets) {

        console.log(`Processing preset: ${presetName}`);

        const presetCardDataFile = getCardDataFilePath(presetName);

        let shouldInitialize = false;

        if (!fs.existsSync(presetCardDataFile)) {

            console.log(`File does not exist for ${presetName}, initializing.`);

            shouldInitialize = true;

        } else {

            let fileContent;

            try {

                fileContent = fs.readFileSync(presetCardDataFile, 'utf8');

                if (Object.keys(JSON.parse(fileContent)).length === 0) {

                    console.log(`File exists but is empty for ${presetName}, initializing.`);

                    shouldInitialize = true;

                } else {

                    console.log(`File exists and is not empty for ${presetName}, skipping initialization.`);

                }

            } catch (error) {

                console.error(`Error reading or parsing file for ${presetName}:`, error);

                shouldInitialize = true; // Attempt to re-initialize if there's an error

            }

        }



        if (shouldInitialize) {

            const defaultCardData = {};

            const generatedIds = new Set();

            while (Object.keys(defaultCardData).length < 27) {

                const min = 1000;

                const max = 9999;

                let fourDigitId = String(Math.floor(Math.random() * (max - min + 1)) + min);



                if (!generatedIds.has(fourDigitId)) {

                    generatedIds.add(fourDigitId);

                    defaultCardData[fourDigitId] = {

                        text: presets[presetName].defaultText,

                        color: presets[presetName].defaultColor,

                        size: presets[presetName].defaultSize,

                        type: presetName, // Store the preset type

                        imagePath: null // No default image

                    };

                }

            }

            if (presetName === 'valentine') {

                defaultCardData['default_card'] = {

                    text: presets[presetName].defaultText,

                    color: presets[presetName].defaultColor,

                    size: presets[presetName].defaultSize,

                    type: presetName,

                    imagePath: null

                };

            }

            try {

                fs.writeFileSync(presetCardDataFile, JSON.stringify(defaultCardData, null, 2));

                console.log(`Successfully wrote file for ${presetName}: ${presetCardDataFile}`);

            } catch (error) {

                console.error(`Error writing file for ${presetName}:`, error);

            }

        }

    }



    console.log('Server initialization completed.');



app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/libs', express.static(path.join(__dirname, 'libs')));

// --- CARD DATA API ---

app.get('/api/card-data/:presetName/:cardId', (req, res) => {
    try {
        const { presetName, cardId } = req.params;
        const cardDataFile = getCardDataFilePath(presetName);
        const allData = JSON.parse(fs.readFileSync(cardDataFile, 'utf8'));
        const cardData = allData[cardId] || { text: "Welcome to Enipp", color: "#ffffff", size: 0.5 };
        
        posthogClient.capture({
            distinctId: cardId,
            event: 'Card Data Loaded (Server-side)',
            properties: {
                cardId: cardId,
            },
        });

        res.send(cardData);
    } catch (error) {
        res.status(500).send({ message: "Error loading card data" });
    }
});

app.post('/api/card-data/:presetName/:cardId', (req, res) => {
    try {
        const { presetName, cardId } = req.params;
        const { text, color, size } = req.body;
        const cardDataFile = getCardDataFilePath(presetName);
        const data = JSON.parse(fs.readFileSync(cardDataFile, 'utf8'));

        data[cardId] = {
            ...data[cardId],
            text,
            color,
            size,
            type: presetName
        };

        fs.writeFileSync(cardDataFile, JSON.stringify(data, null, 2));
        res.send({ message: "JSON updated successfully" });
    } catch (error) {
        res.status(500).send({ message: "Error saving data" });
    }
});

// --- IMAGE UPLOAD CONFIGURATION ---
// --- IMAGE UPLOAD CONFIGURATION ---

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure req.params.project is defined, defaulting to 'project1' if not
        const projectFromUrl = req.params && req.params.project ? req.params.project : 'project1';
        const project = normalizePresetName(projectFromUrl); // Normalize the project name
        const projectPath = path.join(uploadsDir, project);
        if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });
        cb(null, projectPath);
    },
    filename: function (req, file, cb) {
        // Ensure req.params.channelId is defined
        const channelId = req.params && req.params.channelId ? req.params.channelId : 'default'; // Fallback to 'default'
        cb(null, `channel-${channelId}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ storage: storage });

// --- Saves File + Updates JSON ---

app.post('/api/upload/:project/:channelId', (req, res) => {
    const { project: projectFromUrl, channelId } = req.params;
    const uploader = upload.single('image');

    uploader(req, res, function (err) {
        if (err) return res.status(500).send({ message: 'Upload error' });
        if (!req.file) return res.status(400).send({ message: 'No file' });

        const project = normalizePresetName(projectFromUrl); // Normalize the project name
        const filePath = `/uploads/${project}/${req.file.filename}`;

        try {
            const data = JSON.parse(fs.readFileSync(getCardDataFilePath(project), 'utf8'));
            data[channelId] = {
                ...data[channelId],
                imagePath: filePath
            };

            fs.writeFileSync(getCardDataFilePath(project), JSON.stringify(data, null, 2));

            res.send({
                message: 'File uploaded and JSON updated successfully',
                filePath: filePath
            });
        } catch (jsonErr) {
            console.error("JSON Update Error:", jsonErr);
            res.status(500).send({ message: 'File uploaded but failed to update JSON' });
        }
    });
});


app.get('/api/image/:project/:channelId', (req, res) => {
    const { project: projectFromUrl, channelId } = req.params;
    const project = normalizePresetName(projectFromUrl);
    const projectPath = path.join(uploadsDir, project);

    if (fs.existsSync(projectPath)) {
        const files = fs.readdirSync(projectPath);
        const match = files.find(f => f.startsWith(`channel-${channelId}`));
        if (match) return res.send({ filePath: `/uploads/${project}/${match}` });
    }
    res.status(404).send({ message: "Image not found" });
});

app.delete('/api/image/:project/:channelId', (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.DELETE_SECRET_KEY) return res.status(401).send({ message: 'Unauthorized' });

    const { project: projectFromUrl, channelId } = req.params;
    const project = normalizePresetName(projectFromUrl);
    const projectPath = path.join(uploadsDir, project);

    if (fs.existsSync(projectPath)) {
        const files = fs.readdirSync(projectPath);
        const match = files.find(f => f.startsWith(`channel-${channelId}`));
        if (match) {
            fs.unlinkSync(path.join(projectPath, match));
            return res.send({ message: "Deleted successfully" });
        }
    }
    res.status(404).send({ message: "Nothing to delete" });
});


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve index.html for all other client-side routes (e.g., /valentine, /valentine/card123)
app.get('/:presetName', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/:presetName/:cardId', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});