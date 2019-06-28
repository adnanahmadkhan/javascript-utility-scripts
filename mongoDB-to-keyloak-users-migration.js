const mongoose = require("mongoose");
const axios = require("axios");
const _ = require("lodash")
const csvjson = require('csvjson')
const writeFile = require('fs').appendFile;
const https = require('https');
var querystring = require('querystring');

const KCToken = `<TOKEN>`
const REALM = '<REALM-NAME>'
const CLIENT_NAME = '<CLIENT-NAME>'
const adminuserId = '<USER-ID>'
const MONGODB_URI = 'mongodb://<SERVER-ADDRESS>:27017/<DATABASE-NAME>'
const KC_URI = 'https://<KEYCLOAK-ADDRESS>/auth'
const axiosConfig = {
    headers: {
        'Authorization': "bearer " + KCToken,
        'Content-Type': 'application/json'
    }
};

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({  
      rejectUnauthorized: false
    })
  })

mongoose.connect(MONGODB_URI, { useNewUrlParser: true });

/**
 * @function main
 * this is where the main migration occurs
 */
 const main = async () => {
    mongoose.connection.on('connected', () => {
        const db = mongoose.connection.db

        const userCollection = db.collection('users');

        userCollection.find().toArray(function(err, users) {
            if (err) {
                console.log("DEBUG: ", err);
            }
            else {
                console.log("DEBUG: ", "TOTAL LEGNTH: ", users.length)
                users.forEach(async function(user,i,a) {
                    const transformedUser = await transformUser(user);
                    const createResponse = await createSingleUserKC(transformedUser)
                    if (createResponse.error) {
                        console.log("DEBUG: ", "Could not create user: ", createResponse.user.username, " -->> ", createResponse.message, "-->> status: ", createResponse.status)
                    } else {
                        console.log("DEBUG: ", "Created user: ", createResponse.user.username)
                        const userResponse = await getKCUser(createResponse.user)
                        if (userResponse.error) {
                            console.log("DEBUG: ", "Cannot add role to user: ", createResponse.user.username, " -->> ", userResponse.message, "-->> status: ", userResponse.status)
                        } else {
                            const addRoleResponse = addRole(userResponse.user, user.role)
                            if (!addRoleResponse) {
                                console.log("DEBUG: ", "Could not add role to user, deleting from keycloak")
                                deleteUser(createResponse.user.id)
                            } else {
                                writeUserToFile(readyUserForFile(transformedUser));
                            }
                        }
                    }
                });
            }
        })
    });
    console.log("COMPLETED!");
 }

/**
 * @function generatePasswordForUser
 * this function generates a random password for a user
 */
const generatePasswordForUser = async (fancy) => {
    let result
    if (fancy) {
        result = await axios.post(`http://frightanic.com/goodies_content/docker-names.php`, axiosConfig)
        .then(response => {
            return response.data.trim()
        })
        .catch(err => { 
            console.log("DEBUG: ", "Could not generate fancy password, going for plain password")
            return false
        })
    }
    if(result) return result

    const length = 8,
        charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let retVal = "";
    for (let i = 0, n = charset.length; i < length; ++i) {
        retVal += charset.charAt(Math.floor(Math.random() * n));
    }
    return retVal;
}



/**
 * @function createSingleUserKC
 * this function creates a user in keycloak
 */
 const createSingleUserKC = async (user) => {
    // api call to create user
    return await axiosInstance.post(`${KC_URI}/admin/realms/${REALM}/users`, user, axiosConfig)
    .then(response => {
        if ( response.status === 201) {
            return {
                error: false,
                user,
                message: "created",
                status: response.statusText
            }
        } return {error: true, user, message: "no idea whats wrong", status: response.statusText}
    })
    .catch(err => {
        return {error: true, user, message: err.response.data.errorMessage, status: err.response.statusText}
    })
 }


/**
 * @function getKCUserId
 * this function gets userId of keycloak user
 */
 const getKCUser = async (user) => {
    return await axiosInstance.get(`${KC_URI}/admin/realms/${REALM}/users?username=${user.username}`, axiosConfig)
    .then(response => {
        if ( response.status === 200) {
            return {
                error: false,
                user: response.data,
                message: "found",
                status: response.statusText
            }
        } return {error: true, user: response.data, message: "no idea whats wrong", status: response.statusText}
    })
    .catch(err => {
            return {error: true, user, message: err.response.data.errorMessage, status: err.response.statusText}
    })
 }

/**
 * @function addRole
 * this function adds role to recently created KC user
 */
const addRole = async (user, role) => {
    const id = user[0].id
    // Get clientId for client
    const clientId = await axiosInstance.get(`${KC_URI}/admin/realms/${REALM}/clients?clientId=${CLIENT_NAME}`, axiosConfig)
    .then(response => {
        if (response.status === 200) return response.data[0].id
        else return false
    }).catch(err => {
        return false
    })
    if (!clientId) {
        console.log("DEBUG: ", "Cannot find client Id for client: ", CLIENT_NAME)
        return false
    }
    // Get all available roles
    const availableRoles =  await axiosInstance.get(`${KC_URI}/admin/realms/${REALM}/users/${id}/role-mappings/clients/${clientId}/available`, axiosConfig)
    .then(response => {
        if (response.status === 200) return response.data
        else return false
    }).catch(err => {
        console.log("DEBUG: ", err.response.status)
        return false
    })
    if (!availableRoles) {
        console.log("DEBUG: ", "Cannot find available roles for client ",  CLIENT_NAME)
        return false
    }

    // Check if role of user matches existing roles
    const roleToAdd = availableRoles.filter(item => (item.name === role))
    if (_.isEmpty(roleToAdd)) {
        console.log("DEBUG: ", "No matching roles found in client for role ", role)
        return false
    }

    // add that role to user
    const addRoleResponse = await axiosInstance.post(`${KC_URI}/admin/realms/${REALM}/users/${id}/role-mappings/clients/${clientId}`, roleToAdd, axiosConfig)
    .then(response => {
        console.log("DEBUG: ", (response.data))
        console.log("DEBUG: ", (response.status))

        if ( response.status === 204)
            return true
        else return false
    })
    .catch(err => {
        console.log("DEBUG: ", err.response.status)
        return false
    })

    if (addRoleResponse) {
        console.log("DEBUG: ", "Role ("+ role +") added to user: ", user[0].username)
        if(role === "Admin") {
            const addToGroupResponse = await addUserToGroup(id)
            return addToGroupResponse ? true: false
        }
        return true
    }

    console.log("DEBUG: ", "Could not add role to user:  ", user[0].username)
    return false    
};

 /**
 * @function transformUser
 * this function transforms json of a mongodb user, 
 * so it can be used to add corresponding user to keycloak
 */
const transformUser = async (user) => {
    const password = await generatePasswordForUser(false);
    return {
        username: user.userName,
        credentials: [{type: "password", "value": password}],
        email: user.email,
        emailVerified: false,
        enabled: true,
        firstName: user.fullName ? user.fullName.firstName : "",
        lastName: user.fullName ? user.fullName.lastName : "",
        attributes: {
            address: [user.address || ""],
            contact: [user.contact || ""],
            employeeId: [user.employeeId || ""],
            departmentName: [user.departmentName || ""],
            picture: [user.picture || ""],
            createdBy: [adminuserId] // all users are created by adminuser
        },
    }
}

/**
 * @function writeUserToFile
 * this writes a user to a file
 */
const writeUserToFile = (user) => {
    const csvData = csvjson.toCSV(user, {
        headers: 'key'
    });

    writeFile('./keycloak-users.csv', csvData, (err) => {
        if(err) {
            console.log(err); // Do something to handle the error or just throw it
            throw new Error(err);
        }
        console.log('DEBUG: Success! All users written to file');
    });
}

/**
 * @function readyUserForFile
 * this function slices atributes from the created KC user and returns an object of it
 */
const readyUserForFile = (user) => {
    return {
        username: user.username,
        password: user.credentials[0].value,
        email: user.email,
        KCId: user.id
    }
}

/**
 * @function addUserToGroup
 * this function adds a user to a default KC group
 */
const addUserToGroup = async (id) => {
    const defaultGroup = await axiosInstance.get(`${KC_URI}/admin/realms/${REALM}/groups?groupId=default`, axiosConfig)
    const params = {"realm": REALM, "userId": id, "groupId": defaultGroup.data[0].id}
    const response = await axiosInstance.put(`${KC_URI}/admin/realms/${REALM}/users/${id}/groups/${defaultGroup.data[0].id}`, params, axiosConfig)
    if (response.status !== 204) return false
    else {
        console.log("Admin user added to default group")
        return true
    }
}

/**
 * @function deleteUser
 * this function deletes a user in KC
 */
const deleteUser = async (userId) => {
    await axiosInstance.delete(`${KC_URI}/admin/realms/${REALM}/users/${userId}`, axiosConfig)
}

main();

/* ** ******************************************************************************** ** **
                            Example JSON for creating user in keycloak
** ** ******************************************************************************** ** **

const user = {
    "username": "realadmon",
    "credentials": [{
    	"type": "password",
    	"value": "admonpassword"
    }],
    "attributes": {
    	"address": ["Burgundy street, north carolina"],
    	"contact": ["00925476508971"],
    	"employeeId": ["DHK_092376"],
    	"departmentName": ["KNOCK"],
    	"picture": ["https://miniom.ioahYDSbds7$asjah-eu-east.an10.io/admon-guy"],
    	"createdBy": ["badmon"]
    },
    "email": "admon@dmon.mon",
    "emailVerified": false,
    "enabled": true,
    "firstName": "admon",
    "lastName": "grupp",
    "groups": [],
    "realmRoles": ["realmAdmin", "offline_access", "uma_authorization"],
    "clientRoles": {
    	"account": ["manage-account", "view-profile"],
    	"apollo": ["Admin"],
    	"realm-management": ["realm-admin"]
    }
}
*/
