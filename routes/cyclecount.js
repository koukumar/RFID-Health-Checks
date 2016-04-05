var express = require('express');
var router = express.Router();

var utils = require("./utils.js");
require('datejs');
var multer  = require('multer');
var fs = require('fs');
var readline = require('readline');
var upload = multer({dest: 'uploads/'});
var Excel = require('exceljs');

var RFID_CYCLE_COUNT_TABLE = "RFID-Cycle-Count";

//Authenticate Firebase
var firebase_ref = new Firebase(process.env.FIREBASE_URL);
var firebase_secret = process.env.FIREBASE_SECRET;
firebase_ref.authWithCustomToken(firebase_secret, function(error, authData) {
    if (error) {
        console.log("Login Failed!", error);
    } else {
        console.log("Firebase authenticated successfully with payload.");
    }
});

var AWS = require('aws-sdk');
AWS.config.update({region: 'us-east-1'});
var dynamodb = new AWS.DynamoDB({apiVersion: 'latest'});

/* Cycle count file from app. */
router.post('/:accountid/:date', upload.single('file'), function(req, res) {
    var accountid = req.params.accountid || " ";
    var dateString = Date.parse(req.params.date).toString("yyyy-MM-dd mm:HH:ss");
    var partitionKey = accountid + '#' + dateString;
   
    var rd = readline.createInterface({
        input: fs.createReadStream(req.file.path),
        output: process.stdout,
        terminal: false
    });

    var values=[];
    rd.on('line', function(line) {
        values.push(line);
    });

    rd.on('close', function(data) {
        console.log(values.length);
        processCycleCount(values, partitionKey);

    });
    res.status(200).send();
    return;
});


/* Upload item ref file */
router.post('/itemref/:accountid', upload.single('file'), function(req, res) {
    var accountid = req.params.accountid || " ";
    console.log(req.file.path);
    var values= {};

    var workbook = new Excel.Workbook();
    workbook.xlsx.readFile(req.file.path).then(function() {
        // use workbook
        console.log(workbook);
        var worksheet = workbook.getWorksheet(1);
        if(worksheet != null) {
            // Iterate over all rows that have values in a worksheet
            worksheet.eachRow(function(row, rowNumber) {
                /*                values.push({
                 storeId : worksheet.getCell('A'+rowNumber).value,
                 storeName : worksheet.getCell('B'+rowNumber).value,
                 category : worksheet.getCell('C'+rowNumber).value,
                 itemNumber : worksheet.getCell('D'+rowNumber).value,
                 itemFlags : worksheet.getCell('E'+rowNumber).value,
                 itemDesc : worksheet.getCell('F'+rowNumber).value,
                 sizeDesc : worksheet.getCell('G'+rowNumber).value,
                 itemStatus : worksheet.getCell('H'+rowNumber).value,
                 upc : worksheet.getCell('I'+rowNumber).value,
                 posQty : worksheet.getCell('J'+rowNumber).value,
                 posSales : worksheet.getCell('K'+rowNumber).value,
                 currStrOnHandQty : worksheet.getCell('L'+rowNumber).value,
                 }); */
                var upc = worksheet.getCell('I'+rowNumber).value;
                values[upc] = {
                    category : worksheet.getCell('C'+rowNumber).value,
                    itemDesc : worksheet.getCell('F'+rowNumber).value,
                    itemNumber : worksheet.getCell('D'+rowNumber).value
                };
            });
        }
        var itemFileDescRef = firebase_ref.child('/accounts/' + accountid + '/itemfiledetails');
        itemFileDescRef.update({ upc : values});
    });

    res.status(200).send();

    return;
});

router.get('/:epc', function(req, res) {
    var epc = req.params.epc;
    res.status(200).send({
        epc2upc : utils.epc2upc(epc),
        sgtin960 : utils.epc2upcV1(epc)
    });
    return;
});

router.post('/:accountid/:date', function(req, res) {
    var accountid = req.params.accountid || " ";
    var dateString = Date.parse(req.params.date).toString("yyyy-MM-dd mm:HH:ss");
    var partitionKey = accountid + '#' + dateString;
    processCycleCount(req.body)
    res.status(200).send();
});

module.exports = router;

//Functions

function updateItem(partitionKey, sortKey, updateKeys, tableName) {
    var attributes = {};
    for (var key in updateKeys) {
        if (key == "count") {
            attributes[key] = { Action: 'ADD', Value : { N : updateKeys[key]}};
        } else {
            attributes[key] = { Action: 'PUT', Value : { S : updateKeys[key]}};
        }
    }
    var params = {
        Key: {
            partitionKey : {
                S: partitionKey
            },
            sortKey : {
                S: sortKey
            }
        },
        TableName: tableName,
        AttributeUpdates: attributes
    };

    dynamodb.updateItem(params, function(err, data) {
        if (err) console.log(err, err.stack);
        else     console.log(data);
    });
}


function processCycleCount(items, partitionKey) {
    for (var idx in items) {
        var epc = items[idx];
        var upc = utils.epc2upc(epc);
        var sortKey = upc;
        updateItem(partitionKey, sortKey, { Count : 1}, RFID_CYCLE_COUNT_TABLE);
        // Fetch item description from Firebase
        var itemDescRef = firebase_ref.child('/accounts/' + accountid + '/itemfiledetails/upc/' + upc);

        itemDescRef.child('/').once("value", function(snapshot) {
            var itemDesc = snapshot.val();
            if (itemDesc != null && itemDesc != undefined) {
                var updateKeys = {};
                var descAvailable = false;
                if (itemDesc.itemDesc != null) {
                    updateKeys['description'] = itemDesc.itemDesc;
                    descAvailable = true;
                }
                if (itemDesc.itemNumber != null) {
                    updateKeys['itemNumber'] = itemDesc.itemNumber;
                    descAvailable = true;
                }

                if (descAvailable) {
                    updateItem(this.partitionKey, this.sortKey, updateKeys, RFID_CYCLE_COUNT_TABLE);
                }
            }
        }, { sortKey : sortKey, partitionKey : partitionKey});
    }
};